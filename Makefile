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
HELM       = alpine/helm:4.3.0@sha256:a6cf54599ccb99d90cf0712b30f03fdb3cab062e6b94e0418cc4db7e8a1464b2
KUBECONFORM = ghcr.io/yannh/kubeconform:v0.8.0@sha256:faffaf43f95aa6425306e1ab8d6fcad72acb9049158f38e574c085ea1ec0f64e
KUBE_LINTER = stackrox/kube-linter:v0.8.3@sha256:f2bfce7879206d32f69ab6572c376f916643f54ca291ac38cf7d01ef591ff3f9
LOCKFILES  = package-lock.json $(wildcard services/*/uv.lock) evals/simulator/uv.lock
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

.PHONY: trace-check simulate simulator-test help images image-web image-catalog scan-image sbom security-docker dast services-test up down db-start db-stop db-reset db-test db-types db-advisors agents-build services-up services-down \
        agents-logs agents-dev dispatcher-dev voice-dev voice-latency catalog-dev agents-test web lan web-check check security security-secrets security-sast security-deps \
        security-workflows hooks kind-up kind-deploy kind-netpol-test kind-down helm-deps helm-check

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

# The event path without Docker, for development and CI: LangGraph's in-memory dev server (no licence
# needed; same API as the Agent Server) plus the dispatcher, both against the local Supabase.
LOCAL_DB = 127.0.0.1:55422/postgres
# Internal service tokens for local development only; every other environment sets its own secrets.
AGENTS_SERVICE_TOKEN  ?= local-dev-agents-token
CATALOG_SERVICE_TOKEN ?= local-dev-catalog-token
# Set OTEL=1 to send the dev servers' traces and metrics to the collector (make services-up starts it).
OTEL_ENV = $(if $(OTEL),OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318)
agents-dev:      ## agents on LangGraph's dev server at :2024 (GAMENIGHT_MODEL=fake for a free scripted model)
	cd services/agents && $(OTEL_ENV) AGENTS_DATABASE_URL=postgresql://agents_svc:local-dev-agents@$(LOCAL_DB) \
	  GAME_MASTER_DATABASE_URL=postgresql://game_master_svc:local-dev-game-master@$(LOCAL_DB) \
	  AGENTS_SERVICE_TOKEN=$(AGENTS_SERVICE_TOKEN) CATALOG_URL=http://127.0.0.1:8136 \
	  CATALOG_SERVICE_TOKEN=$(CATALOG_SERVICE_TOKEN) uv run langgraph dev --port 2024 --no-browser --no-reload
dispatcher-dev:  ## the dispatcher, pointed at agents-dev (health on :8134)
	cd services/dispatcher && $(OTEL_ENV) PORT=8134 AGENTS_URL=http://127.0.0.1:2024 AGENTS_SERVICE_TOKEN=$(AGENTS_SERVICE_TOKEN) \
	  DATABASE_URL=postgresql://dispatcher_svc:local-dev-dispatcher@$(LOCAL_DB) uv run python -m gamenight_dispatcher
GAMENIGHT_VOICE ?= fake
voice-dev:       ## the voice service on :8135: a free tone by default; GAMENIGHT_VOICE=elevenlabs speaks (needs ELEVENLABS_API_KEY)
	@key=$$(npx supabase status -o env | sed -n 's/^PUBLISHABLE_KEY="\(.*\)"$$/\1/p'); \
	cd services/voice && $(OTEL_ENV) PORT=8135 GAMENIGHT_VOICE=$(GAMENIGHT_VOICE) \
	  DATABASE_URL=postgresql://voice_svc:local-dev-voice@$(LOCAL_DB) \
	  SUPABASE_URL=http://127.0.0.1:55421 SUPABASE_PUBLISHABLE_KEY=$$key \
	  VOICE_STORAGE_EMAIL=voice@gamenight.test VOICE_STORAGE_PASSWORD=local-dev-voice-storage \
	  uv run python -m gamenight_voice
voice-latency:   ## time line to clip with the real voice (needs voice-dev with GAMENIGHT_VOICE=elevenlabs; ~2k characters)
	cd services/voice && uv run python -m evals.latency
catalog-dev:     ## the catalog's games API on :8136
	$(OTEL_ENV) PORT=8136 CATALOG_SERVICE_TOKEN=$(CATALOG_SERVICE_TOKEN) \
	  CATALOG_DATABASE_URL=postgresql://catalog_svc:local-dev-catalog@$(LOCAL_DB) npm start -w @gamenight/catalog
agents-test:     ## lint and unit-test the agent graphs
	cd services/agents && uv run ruff check . && uv run pytest -q

web:             ## Next.js dev server on http://localhost:3100
	$(OTEL_ENV) npm run dev -w @gamenight/web
lan:             ## dev server for real phones on your Wi-Fi (join QR and Supabase use the laptop's address)
	@ip=$$(ipconfig getifaddr en0 2>/dev/null || hostname -I 2>/dev/null | awk '{print $$1}'); \
	test -n "$$ip" || { echo "Couldn't find this machine's Wi-Fi address."; exit 1; }; \
	echo "TV: http://$$ip:3100/tv    Phones: scan the QR on the TV"; \
	$(OTEL_ENV) LAN_HOST=$$ip PUBLIC_ORIGIN=http://$$ip:3100 SUPABASE_BROWSER_URL=http://$$ip:55421 \
	  npm run dev -w @gamenight/web -- -H 0.0.0.0
web-check:       ## typecheck and lint the web app
	npm run typecheck -w @gamenight/web && npm run lint -w @gamenight/web

check: db-test db-advisors web-check agents-test services-test simulator-test   ## build and test checks CI runs

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
image-catalog:
	docker build -t $(IMAGE_PREFIX)-catalog:$(TAG) -f services/catalog/Dockerfile .
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


trace-check:     ## after a join, confirm one trace spans web, dispatcher, agents (needs the collector stack)
	python3 scripts/trace-check.py

GAMES ?= 20
GM ?= referee
GAME ?= undercover
simulate:        ## play GAMES simulated games (default 20) of GAME (undercover or quiz); GM=agents plays the real game master (needs agents-dev, dispatcher-dev); VOICE=1 checks every line is voiced (needs voice-dev)
	@key=$$(npx supabase status -o env | sed -n 's/^PUBLISHABLE_KEY="\(.*\)"$$/\1/p'); \
	cd evals/simulator && SUPABASE_PUBLISHABLE_KEY=$$key AGENTS_SERVICE_TOKEN=$(AGENTS_SERVICE_TOKEN) \
	  uv run python -m gamenight_simulator --games $(GAMES) --game $(GAME) --game-master $(GM) $(if $(VOICE),--voice)
simulator-test:  ## lint and unit-test the game simulator
	cd evals/simulator && uv run ruff check . && uv run pytest -q

# ---- Kubernetes (slice 4b): every service in a local kind cluster, deployed with Helm ----------------------------
# Supabase stays outside the cluster (make db-start); pods reach it through the `supabase` Service.
KIND_CLUSTER ?= gamenight
KUBE = kubectl --context kind-$(KIND_CLUSTER) -n gamenight
KIND_MODEL ?= fake
CHART = infra/helm/gamenight

kind-up:         ## create the local cluster: kind, metrics-server, and a namespace that enforces the restricted Pod Security profile
	kind get clusters | grep -qx $(KIND_CLUSTER) || kind create cluster --config infra/kind/cluster.yaml --wait 120s
	kubectl --context kind-$(KIND_CLUSTER) apply -f infra/kind/metrics-server.yaml
	kubectl --context kind-$(KIND_CLUSTER) create namespace gamenight --dry-run=client -o yaml | kubectl --context kind-$(KIND_CLUSTER) apply -f -
	kubectl --context kind-$(KIND_CLUSTER) label namespace gamenight --overwrite \
	  pod-security.kubernetes.io/enforce=restricted pod-security.kubernetes.io/warn=restricted pod-security.kubernetes.io/audit=restricted

helm-deps:       ## vendor the library chart into each service's chart
	@for chart in $(CHART)/charts/*/; do docker run --rm -v "$(CURDIR)":/src -w /src $(HELM) dependency update $$chart >/dev/null || exit 1; done

kind-deploy: images helm-deps ## build every image, load it into kind, make each service's Secret, and install the chart (KIND_MODEL=anthropic plays the real game master; GAMENIGHT_VOICE=elevenlabs speaks)
	for s in $(SERVICES); do kind load docker-image $(IMAGE_PREFIX)-$$s:$(TAG) --name $(KIND_CLUSTER) || exit 1; done
	scripts/kind-secrets.sh
	helm upgrade --install gamenight $(CHART) --kube-context kind-$(KIND_CLUSTER) -n gamenight \
	  --set global.supabase.hostIP=$$(scripts/kind-host-ip.sh) \
	  --set agents.env.GAMENIGHT_MODEL=$(KIND_MODEL) --set voice.env.GAMENIGHT_VOICE=$(GAMENIGHT_VOICE) \
	  --wait --timeout 10m
	$(KUBE) rollout restart $(SERVICES:%=deployment/%) >/dev/null  # our images were rebuilt under the same tag
	$(KUBE) rollout status deployment --timeout 5m
	@echo "gamenight is up in kind: http://localhost:3400/tv"

kind-netpol-test: ## prove the network policies are enforced: every allowed link connects, every forbidden one fails
	scripts/kind-netpol-test.sh

kind-down:       ## delete the local cluster
	kind delete cluster --name $(KIND_CLUSTER)

helm-check: helm-deps ## lint the chart, validate what it renders against the Kubernetes schemas, and scan it with kube-linter
	docker run --rm -v "$(CURDIR)":/src -w /src $(HELM) lint $(CHART) --set global.supabase.hostIP=10.0.0.1
	docker run --rm -v "$(CURDIR)":/src -w /src $(HELM) template gamenight $(CHART) -n gamenight \
	  --set global.supabase.hostIP=10.0.0.1 > .helm-rendered.yaml
	docker run --rm -v "$(CURDIR)":/src -w /src $(KUBECONFORM) -strict -summary -kubernetes-version 1.37.0 .helm-rendered.yaml; \
	  status=$$?; docker run --rm -v "$(CURDIR)":/src -w /src $(KUBE_LINTER) lint .helm-rendered.yaml || status=1; \
	  rm -f .helm-rendered.yaml; exit $$status
