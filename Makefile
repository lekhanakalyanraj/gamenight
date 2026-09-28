# gamenight developer commands. Everything runs locally: Supabase via its CLI, agent services via docker compose.
COMPOSE = docker compose -f infra/docker-compose.yml --env-file .env

# Security scanners, pinned by version and digest. CI calls these same targets, so a local run matches CI.
SEMGREP    = semgrep/semgrep:1.178.0@sha256:32e459968daabe7ab86968184a29109b9564aa00392401156f9788452b42786b
GITLEAKS   = zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f
OSV        = ghcr.io/google/osv-scanner:v2.6.0@sha256:afd838850ac1a0fcc15ff4a041dc9ba11123c3f0d2666217a5f0fcf9222b55fa
ACTIONLINT = rhysd/actionlint:1.7.12@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667
ZIZMOR     = zizmor@1.30.1
SEMGREP_RULESETS = --config p/typescript --config p/react --config p/nextjs --config p/python --config p/owasp-top-ten
# The repo is mounted into each scanner; git inside the container must trust it despite the different owner.
SCAN = docker run --rm -v "$(CURDIR)":/src -w /src \
       -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0=/src

.PHONY: help up down db-start db-stop db-reset db-test db-types db-advisors agents-build agents-up agents-down \
        agents-logs agents-test web lan web-check check security security-secrets security-sast security-deps \
        security-workflows hooks

help:            ## list commands
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed -E 's/:.*## /\t/'

up: db-start agents-up                    ## start Supabase and the agent services
down: agents-down db-stop                 ## stop everything

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

agents-build:    ## build the Agent Server image from services/agents
	cd services/agents && uvx --from langgraph-cli langgraph build -t gamenight-agents:dev -c langgraph.json
agents-up:       ## start Agent Server, its Postgres and Redis
	$(COMPOSE) up -d
agents-down:
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
	LAN_HOST=$$ip PUBLIC_ORIGIN=http://$$ip:3100 NEXT_PUBLIC_SUPABASE_URL=http://$$ip:55421 \
	  npm run dev -w @gamenight/web -- -H 0.0.0.0
web-check:       ## typecheck and lint the web app
	npm run typecheck -w @gamenight/web && npm run lint -w @gamenight/web

check: db-test db-advisors web-check agents-test   ## build and test checks CI runs

security: security-secrets security-sast security-deps security-workflows   ## every static security check CI runs
security-secrets:   ## gitleaks over the full git history
	$(SCAN) $(GITLEAKS) git /src --redact --no-banner
security-sast:      ## Semgrep: test our custom rules, then scan with community and custom rules
	$(SCAN) -w /src/.semgrep $(SEMGREP) semgrep --test --metrics=off .
	$(SCAN) $(SEMGREP) semgrep scan --metrics=off $(SEMGREP_RULESETS) --config .semgrep/ --error $(SEMGREP_ARGS)
security-deps:      ## OSV-Scanner over the npm and uv lockfiles
	$(SCAN) $(OSV) scan source -L package-lock.json -L services/agents/uv.lock
security-workflows: ## zizmor and actionlint over the GitHub Actions workflows
	uvx $(ZIZMOR) $(ZIZMOR_ARGS) .github/
	$(SCAN) $(ACTIONLINT) -color

hooks:           ## install the pre-commit hooks (gitleaks, ruff)
	uvx pre-commit install
