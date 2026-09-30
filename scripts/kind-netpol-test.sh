#!/usr/bin/env bash
# Proves the cluster enforces the network policies, rather than trusting it: a probe pod for each service carries
# that service's name (so its NetworkPolicy governs it) and tries every link the service is allowed, which must
# connect, and links it isn't, which must fail. The probes' own instance label keeps them out of the services'
# ReplicaSets and Services. They run under the namespace's restricted profile, like everything else.
set -uo pipefail
ctx="kind-${KIND_CLUSTER:-gamenight}"
ns="${KIND_NAMESPACE:-gamenight}"
kube=(kubectl --context "$ctx" -n "$ns")
image="busybox:1.37@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e"
probes=(web agents dispatcher voice catalog redis outsider)

probe_pod() {  # the pod for one service's identity ("outsider": a pod no policy allows anything)
  cat <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: probe-$1
  labels:
    app.kubernetes.io/name: $1
    app.kubernetes.io/instance: netpol-probe
spec:
  automountServiceAccountToken: false
  terminationGracePeriodSeconds: 0
  securityContext:
    runAsNonRoot: true
    runAsUser: 65534
    runAsGroup: 65534
    seccompProfile: {type: RuntimeDefault}
  containers:
    - name: probe
      image: $image
      command: ["sleep", "600"]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities: {drop: [ALL]}
      resources:
        requests: {cpu: 10m, memory: 16Mi}
        limits: {cpu: 100m, memory: 32Mi}
EOF
}

cleanup() { "${kube[@]}" delete pod "${probes[@]/#/probe-}" --ignore-not-found --wait=false >/dev/null 2>&1; }
trap cleanup EXIT
for p in "${probes[@]}"; do probe_pod "$p" | "${kube[@]}" apply -f - >/dev/null; done
"${kube[@]}" wait --for=condition=Ready "${probes[@]/#/pod/probe-}" --timeout=120s >/dev/null || exit 1

failures=0
check() {  # expect (open|closed), from, host, port
  local expect=$1 from=$2 host=$3 port=$4 got
  if "${kube[@]}" exec "probe-$from" -- nc -z -w 3 "$host" "$port" >/dev/null 2>&1; then got=open; else got=closed; fi
  if [ "$got" = "$expect" ]; then
    printf 'ok    %-10s -> %-26s %s\n' "$from" "$host:$port" "$got"
  else
    printf 'FAIL  %-10s -> %-26s %s (expected %s)\n' "$from" "$host:$port" "$got" "$expect"
    failures=$((failures + 1))
  fi
}

echo "Allowed links (must connect):"
check open web agents 8000
check open web supabase 55421
check open agents agent-postgres 5432
check open agents redis 6379
check open agents catalog 8080
check open agents supabase 55421
check open agents supabase 55422
check open agents api.anthropic.com 443
check open dispatcher agents 8000
check open dispatcher supabase 55422
check open voice supabase 55421
check open voice supabase 55422
check open voice api.elevenlabs.io 443
check open catalog supabase 55422

echo "Forbidden links (must fail):"
check closed voice agents 8000
check closed web agent-postgres 5432
check closed web redis 6379
check closed web catalog 8080
check closed web supabase 55422
check closed web api.anthropic.com 443
check closed dispatcher redis 6379
check closed dispatcher supabase 55421
check closed catalog api.anthropic.com 443
check closed catalog agents 8000
check closed agents web 3100
check closed redis api.anthropic.com 443
check closed outsider agents 8000
check closed outsider agent-postgres 5432
check closed outsider supabase 55422

if [ "$failures" -gt 0 ]; then
  echo "$failures network-policy checks failed"
  exit 1
fi
echo "All network-policy checks passed"
