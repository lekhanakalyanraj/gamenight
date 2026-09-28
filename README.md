# gamenight

A multiplayer party-game platform: a **TV** hosts the room, players join from their **phones**, and a team of **AI agents** runs the games and narrates them out loud.

- **Web:** Next.js 16 (App Router, TypeScript, Tailwind) for the TV view, the phone view and the host console
- **Data and auth:** Supabase. Postgres is the system of record; row-level security protects per-player secrets; Realtime keeps every screen in sync; hosts sign in and guests join anonymously
- **Agents:** Python LangGraph on a self-hosted Agent Server. A supervisor hands game events to game-master agents, which act only through validated Postgres functions
- **Observability:** OpenTelemetry for the services, LangSmith for model traces and evals

Read the [design doc](docs/design.md) first. Decisions are recorded in [docs/adr](docs/adr).

## Status

| Slice | What | State |
|---|---|---|
| 0 | Monorepo, Supabase schema v0 with RLS tests, host and guest auth, Agent Server spike, CI | **done** |
| 1 | Rooms without AI: live lobby, TV view, join by QR | next |
| 2 | Dispatcher, supervisor, host chat, OpenTelemetry and LangSmith wiring | |
| 3–7 | Undercover, narration, Quiz Night, Mafia, Heads Up | |
| 8 | Eval suite, dashboards, load test | |

## Run it locally

Prerequisites: Docker, Node 22+, [uv](https://docs.astral.sh/uv/), and a LangSmith API key (the self-hosted Agent Server checks it at startup; see [ADR 0001](docs/adr/0001-agent-server-licensing.md)).

```bash
npm install                       # web app + Supabase CLI
cp .env.example .env              # add ANTHROPIC_API_KEY and LANGSMITH_API_KEY
make db-start                     # Supabase on ports 55421-55429 (Studio: http://127.0.0.1:55423)
cp apps/web/.env.example apps/web/.env.local   # publishable key from `npx supabase status -o env`
make agents-build agents-up       # Agent Server on http://localhost:8123
make web                          # http://localhost:3100
```

Sign in as the local demo host (`host@gamenight.test`, password in [supabase/seed.sql](supabase/seed.sql)), create a room, then join from another browser with the room code.

## Checks

```bash
make check        # pgTAP (RLS + RPCs), web typecheck + lint, agent lint + tests
```

## Layout

```
apps/web/              Next.js app
packages/db-types/     TypeScript types generated from the schema (make db-types)
services/agents/       LangGraph graphs and the Agent Server config
supabase/migrations/   schema, RLS policies, RPCs, realtime triggers
supabase/tests/        pgTAP tests
infra/                 docker-compose for the agent services
docs/                  design doc and ADRs
```
