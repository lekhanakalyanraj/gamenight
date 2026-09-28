# gamenight developer commands. Everything runs locally: Supabase via its CLI, agent services via docker compose.
COMPOSE = docker compose -f infra/docker-compose.yml --env-file .env

.PHONY: help up down db-start db-stop db-reset db-test db-types agents-build agents-up agents-down agents-logs \
        agents-test web web-check check

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
web-check:       ## typecheck and lint the web app
	npm run typecheck -w @gamenight/web && npm run lint -w @gamenight/web

check: db-test web-check agents-test      ## everything CI runs
