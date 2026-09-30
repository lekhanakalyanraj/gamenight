#!/usr/bin/env bash
# One Kubernetes Secret per service, holding only what that service needs: the provider keys come from .env (or
# the environment, in CI), and the database logins are the local ones from supabase/seed.sql. Nothing sensitive is
# in the chart or its values. Each Deployment mounts only the Secret with its own name.
set -euo pipefail
cd "$(dirname "$0")/.."
kube=(kubectl --context "kind-${KIND_CLUSTER:-gamenight}" -n "${KIND_NAMESPACE:-gamenight}")

if [ -f .env ]; then set -a; . ./.env; set +a; fi
publishable=$(npx supabase status -o env 2>/dev/null | sed -n 's/^PUBLISHABLE_KEY="\(.*\)"$/\1/p')
[ -n "$publishable" ] || { echo "Start Supabase first: make db-start" >&2; exit 1; }
[ -n "${LANGSMITH_API_KEY:-}" ] || { echo "LANGSMITH_API_KEY is required: the Agent Server checks it at startup" >&2; exit 1; }

agents_token="${AGENTS_SERVICE_TOKEN:-local-dev-agents-token}"
catalog_token="${CATALOG_SERVICE_TOKEN:-local-dev-catalog-token}"
db="supabase:55422/postgres"
agent_pg_password="local-dev-agent-postgres"

secret() {  # name, then KEY=value pairs
  local name=$1; shift
  local args=()
  for pair in "$@"; do args+=(--from-literal="$pair"); done
  "${kube[@]}" create secret generic "$name" "${args[@]}" --dry-run=client -o yaml | "${kube[@]}" apply -f - >/dev/null
  echo "secret/$name: $# keys"
}

secret web "SUPABASE_PUBLISHABLE_KEY=$publishable" "AGENTS_SERVICE_TOKEN=$agents_token"
secret agents \
  "DATABASE_URI=postgres://postgres:$agent_pg_password@agent-postgres:5432/langgraph?sslmode=disable" \
  "AGENTS_DATABASE_URL=postgresql://agents_svc:local-dev-agents@$db" \
  "GAME_MASTER_DATABASE_URL=postgresql://game_master_svc:local-dev-game-master@$db" \
  "ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}" "LANGSMITH_API_KEY=$LANGSMITH_API_KEY" \
  "AGENTS_SERVICE_TOKEN=$agents_token" "CATALOG_SERVICE_TOKEN=$catalog_token"
secret dispatcher "DATABASE_URL=postgresql://dispatcher_svc:local-dev-dispatcher@$db" "AGENTS_SERVICE_TOKEN=$agents_token"
secret voice "DATABASE_URL=postgresql://voice_svc:local-dev-voice@$db" "SUPABASE_PUBLISHABLE_KEY=$publishable" \
  "VOICE_STORAGE_PASSWORD=local-dev-voice-storage" "ELEVENLABS_API_KEY=${ELEVENLABS_API_KEY:-}"
secret catalog "CATALOG_DATABASE_URL=postgresql://catalog_svc:local-dev-catalog@$db" "CATALOG_SERVICE_TOKEN=$catalog_token"
secret agent-postgres "POSTGRES_PASSWORD=$agent_pg_password"
