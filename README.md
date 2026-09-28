# gamenight

[![ci](https://github.com/lekhanakalyanraj/gamenight/actions/workflows/ci.yml/badge.svg)](https://github.com/lekhanakalyanraj/gamenight/actions/workflows/ci.yml)
[![security](https://github.com/lekhanakalyanraj/gamenight/actions/workflows/security.yml/badge.svg)](https://github.com/lekhanakalyanraj/gamenight/actions/workflows/security.yml)
[![codeql](https://github.com/lekhanakalyanraj/gamenight/actions/workflows/codeql.yml/badge.svg)](https://github.com/lekhanakalyanraj/gamenight/actions/workflows/codeql.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/lekhanakalyanraj/gamenight/badge)](https://scorecard.dev/viewer/?uri=github.com/lekhanakalyanraj/gamenight)

A multiplayer party-game platform: a **TV** hosts the room, players join from their **phones**, and a team of **AI agents** runs the games and narrates them out loud.

- **Web:** Next.js 16 (App Router, TypeScript, Tailwind) for the TV view, the phone view and the host console
- **Data and auth:** Supabase. Postgres is the system of record; row-level security protects per-player secrets; Realtime keeps every screen in sync; hosts sign in and guests join anonymously
- **Agents:** Python LangGraph on a self-hosted Agent Server. A supervisor hands game events to game-master agents, which act only through validated Postgres functions
- **Observability:** OpenTelemetry for the services, LangSmith for model traces and evals

## Status

| Slice | What | State |
|---|---|---|
| 0 | Monorepo, Supabase schema v0 with RLS tests, host and guest auth, Agent Server spike, CI | **done** |
| 0.5 | Security pipeline: SAST, secrets, dependency and workflow scanning, database advisors | **in review** |
| 1 | Rooms without AI: live lobby, TV view, join by QR | next |
| 2 | Dispatcher, supervisor, host chat, OpenTelemetry and LangSmith wiring | |
| 3–7 | Undercover, narration, Quiz Night, Mafia, Heads Up | |
| 8 | Eval suite, dashboards, load test | |

## Run it locally

Prerequisites: Docker, Node 22+, [uv](https://docs.astral.sh/uv/), and a LangSmith API key (the self-hosted Agent Server checks it at startup; production needs a LangGraph licence key).

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
make check        # pgTAP (RLS + RPCs), database advisors, web typecheck + lint, agent lint + tests
make security     # gitleaks, Semgrep, OSV-Scanner, zizmor, actionlint (needs Docker and uv)
make hooks        # install pre-commit hooks (gitleaks, ruff)
```

## Security

Every PR runs the checks below; they also run daily on main, so newly disclosed vulnerabilities show up without a code change. See [SECURITY.md](SECURITY.md) to report a vulnerability.

| Check | Tool | What it guards |
|---|---|---|
| Row-level security and RPCs | pgTAP | Players only see their own secrets and rooms; every table has RLS; only the room RPCs are callable |
| Database advisors | Supabase splinter | Misconfigured RLS, exposed `SECURITY DEFINER` functions, mutable `search_path` |
| Static analysis | Semgrep (community + [custom rules](.semgrep/)), CodeQL | Injection, XSS, and repo rules: no RLS-bypass key, no raw HTML, writes only through RPCs |
| Secrets | gitleaks | Keys in any commit, ever |
| Dependencies | OSV-Scanner, dependency review, Dependabot | Known vulnerabilities in npm and PyPI packages; licences of new ones |
| CI itself | zizmor, actionlint, OpenSSF Scorecard | Actions pinned by SHA, least-privilege tokens, no script injection |

Coming with the agent slices: LLM and agent red teaming mapped to the OWASP Top 10 for LLM Applications (2026) and for Agentic Applications, and eval gates on every agent change.

## Layout

```
apps/web/              Next.js app
packages/db-types/     TypeScript types generated from the schema (make db-types)
services/agents/       LangGraph graphs and the Agent Server config
supabase/migrations/   schema, RLS policies, RPCs, realtime triggers
supabase/tests/        pgTAP tests
infra/                 docker-compose for the agent services
scripts/               repo tooling (database advisors)
.semgrep/              custom Semgrep rules, each with test cases
```
