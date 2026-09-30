#!/usr/bin/env bash
# The host's address as the kind node (and so every pod) sees it: where Supabase runs, outside the cluster.
# Docker Desktop (a Mac) names it host.docker.internal; on Linux (CI) it's the kind network's gateway.
set -euo pipefail
node="${KIND_CLUSTER:-gamenight}-control-plane"
ip=$(docker exec "$node" getent ahostsv4 host.docker.internal 2>/dev/null | awk 'NR == 1 { print $1 }' || true)
if [ -z "$ip" ]; then
  ip=$(docker network inspect kind -f '{{range .IPAM.Config}}{{.Gateway}} {{end}}' | tr ' ' '\n' | grep -E '^[0-9]+\.' | head -n 1)
fi
[ -n "$ip" ] || { echo "Couldn't find the host's address from the kind node." >&2; exit 1; }
echo "$ip"
