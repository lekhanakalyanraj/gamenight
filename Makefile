# gamenight developer commands. Everything runs locally: Supabase via its CLI, agent services via docker compose.
COMPOSE = docker compose -f infra/docker-compose.yml --env-file .env

# Security scanners, pinned by version and digest. CI calls these same targets, so a local run matches CI.
SEMGREP    = semgrep/semgrep:1.178.0@sha256:32e459968daabe7ab86968184a29109b9564aa00392401156f9788452b42786b
GITLEAKS   = zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f
OSV        = ghcr.io/google/osv-scanner:v2.6.0@sha256:afd838850ac1a0fcc15ff4a041dc9ba11123c3f0d2666217a5f0fcf9222b55fa
ACTIONLINT = rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667
ZIZMOR     = zizmor@1.30.1
GRYPE      = anchore/grype:v0.119.0@sha256:8c2c9234a345577a6d321a4753aa3ee1276d8975c8452d2344a56b57733ecad3
SYFT       = anchore/syft:v1.52.0@sha256:500e2d872ac019436926e8322b4fc1f39441d94d21f6f4046c6ff29b30e8cb02
HADOLINT   = hadolint/hadolint:v2.15.1@sha256:32dac94127fd60b7b7e3fbfc65e1383b9b5e25c9bfd7b8536de7a539fe68a12d
ZAP        = ghcr.io/zaproxy/zaproxy:2.17.0@sha256:781a2bdaea47324e7bab583e2263f21d257b0aee61ed51521a5be45f5f5081ef
LOCKFILES  = package-lock.json $(wildcard services/*/uv.lock)
DOCKERFILES = apps/web/Dockerfile $(wildcard services/*/Dockerfile)

# Every deployable service has its own image (see the README's service map).
SERVICES     = web agents dispatcher voice catalog
IMAGE_PREFIX ?= gamenight
TAG          ?= dev
DOCKER_SOCK  = -v /var/run/docker.sock:/var/run/docker.sock
SEMGREP_RULESETS = --config p/typescript --config p/react --config p/nextjs --config p/python --config p/owasp-top-ten
# The repo is mounted into each scanner; git inside the container must trust it despite the different owner.
SCAN = docker run --rm -v "$(CURDIR)":/src -w /src \
       -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0=/src

.PHONY: help images image-web scan-image sbom security-docker dast services-test up down db-start db-stop db-reset db-test db-types db-advisors agents-build services-up services-down \
        agents-logs agents-test web lan web-check check security security-secrets security-sast security-deps \
        security-workflows hooks

help:            ## list commands
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed -E 's/:.*## /\t/'

up: db-start services-up                  ## start Supabase and every service
down: services-down db-stop               ## stop everything

db-start:        ## start local Supabase (Postgres, Auth, Realtime, Storage, Studio)
	npx supabase start
db-stop:
	npx supabase stop
db-reset:        ## re-apply migrations and seed (wipes local data)
	npx supabase db reset
db-test:         ## pgTAP tests for RLS and RPCs
	npx supabase test db
db-types:        ## regenerate TypeScript types from the schema
	npm run db:types
db-advisors:     ## Supabase security advisors (splinter) against the local database
	python3 scripts/db-advisors.py

agents-build: image-agents   ## build the Agent Server image from services/agents
services-up:     ## start every service in Docker (build them first with make images)
	SUPABASE_PUBLISHABLE_KEY=$$(npx supabase status -o env | sed -n 's/^PUBLISHABLE_KEY="\(.*\)"$$/\1/p') $(COMPOSE) up -d
services-down:
	$(COMPOSE) down
agents-logs:
	$(COMPOSE) logs -f agent-server
agents-test:     ## lint and unit-test the agent graphs
	cd services/agents && uv run ruff check . && uv run pytest -q

web:             ## Next.js dev server on http://localhost:3100
	npm run dev -w @gamenight/web
lan:             ## dev server for real phones on your Wi-Fi (join QR and Supabase use the laptop's address)
	@ip=$$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $$1}'); \
	test -n "$$ip" || { echo "Couldn't find this machine's Wi-Fi address."; exit 1; }; \
	echo "TV: http://$$ip:3100/tv    Phones: scan the QR on the TV"; \
	LAN_HOST=$$ip PUBLIC_ORIGIN=http://$$ip:3100 SUPABASE_BROWSER_URL=http://$$ip:55421 \
	  npm run dev -w @gamenight/web -- -H 0.0.0.0
web-check:       ## typecheck and lint the web app
	npm run typecheck -w @gamenight/web && npm run lint -w @gamenight/web

check: db-test db-advisors web-check agents-test services-test   ## build and test checks CI runs

security: security-secrets security-sast security-deps security-workflows security-docker   ## every static security check CI runs
security-secrets:   ## gitleaks over the full git history
	$(SCAN) $(GITLEAKS) git /src --redact --no-banner
security-sast:      ## Semgrep: test our custom rules, then scan with community and custom rules
	$(SCAN) -w /src/.semgrep $(SEMGREP) semgrep --test --metrics=off .
	$(SCAN) $(SEMGREP) semgrep scan --metrics=off $(SEMGREP_RULESETS) --config .semgrep/ --error $(SEMGREP_ARGS)
security-deps:      ## OSV-Scanner over the npm and uv lockfiles
	$(SCAN) $(OSV) scan source $(addprefix -L ,$(LOCKFILES))
security-workflows: ## zizmor and actionlint over the GitHub Actions workflows
	uvx $(ZIZMOR) $(ZIZMOR_ARGS) .github/
	$(SCAN) $(ACTIONLINT) -color

hooks:           ## install the pre-commit hooks (gitleaks, ruff)
	uvx pre-commit install
security-docker:    ## hadolint over every Dockerfile
	@for f in $(DOCKERFILES); do echo "hadolint $$f"; docker run --rm -i $(HADOLINT) < $$f || exit 1; done

images: $(SERVICES:%=image-%)   ## build every service image as $(IMAGE_PREFIX)-<service>:$(TAG)
image-web:
	docker build -t $(IMAGE_PREFIX)-web:$(TAG) -f apps/web/Dockerfile .
image-%:
	docker build -t $(IMAGE_PREFIX)-$*:$(TAG) services/$*
# A service's directory, and its Grype exceptions file if it has one (each exception carries a reason).
svc_dir     = $(if $(filter web,$1),apps/web,services/$1)
grype_rules = $(wildcard $(call svc_dir,$1)/.grype.yaml)
scan-%:          ## Grype a built service image, e.g. make scan-web: fail on fixable high or critical
	docker run --rm $(DOCKER_SOCK) $(if $(call grype_rules,$*),-v "$(CURDIR)/$(call grype_rules,$*)":/grype.yaml:ro) \
	  $(GRYPE) $(IMAGE_PREFIX)-$*:$(TAG) $(if $(call grype_rules,$*),-c /grype.yaml) --only-fixed --fail-on high
scan-image:      ## Grype any image: fail on fixable high or critical vulnerabilities (IMAGE=...)
	docker run --rm $(DOCKER_SOCK) $(GRYPE) $(IMAGE) --only-fixed --fail-on high
sbom:            ## Syft: SPDX SBOM for IMAGE=... into OUT=...
	docker run --rm $(DOCKER_SOCK) -v "$(CURDIR)":/out $(SYFT) $(IMAGE) -o spdx-json=/out/$(OUT)

services-test:   ## lint and test the dispatcher, voice and catalog services
	cd services/dispatcher && uv run ruff check . && uv run pytest -q
	cd services/voice && uv run ruff check . && uv run pytest -q
	npm run typecheck -w @gamenight/catalog && npm test -w @gamenight/catalog

# OWASP ZAP baseline (passive) scan against a running production build. CI sets DAST_TARGET and DAST_DOCKER_ARGS.
DAST_TARGET      ?= http://host.docker.internal:3100
DAST_DOCKER_ARGS ?=
dast:            ## ZAP baseline scan of the running web app; report in .zap/report
	mkdir -p .zap/report && chmod a+w .zap .zap/report
	docker run --rm $(DAST_DOCKER_ARGS) -v "$(CURDIR)/.zap":/zap/wrk:rw $(ZAP) \
	  zap-baseline.py -t $(DAST_TARGET) -c rules.tsv -r report/zap.html -J report/zap.json -j

