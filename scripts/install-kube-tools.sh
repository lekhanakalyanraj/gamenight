#!/usr/bin/env bash
# kind, Helm and kubectl for CI (Linux x86-64), at pinned versions and verified against pinned checksums, rather
# than whatever the runner image happens to have. kubectl matches the Kubernetes version kind v0.33.0's node runs.
set -euo pipefail
bin="${1:-$HOME/.local/bin}"
mkdir -p "$bin"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fetch() {  # url, sha256, file
  curl -fsSL --retry 3 "$1" -o "$tmp/$3"
  echo "$2  $tmp/$3" | sha256sum --check --quiet
}

fetch https://github.com/kubernetes-sigs/kind/releases/download/v0.33.0/kind-linux-amd64 \
  aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d kind
fetch https://get.helm.sh/helm-v4.3.0-linux-amd64.tar.gz \
  86584a54def73570558f66f5111cc53dfed56689637ae32c1201205d494f54fb helm.tar.gz
fetch https://dl.k8s.io/release/v1.37.0/bin/linux/amd64/kubectl \
  6129359f4e1f3848a5572ccb0b26cf28b8ca08cef38c95a765b2f64a2c961a2f kubectl

tar -xzf "$tmp/helm.tar.gz" -C "$tmp" linux-amd64/helm
install -m 0755 "$tmp/kind" "$bin/kind"
install -m 0755 "$tmp/linux-amd64/helm" "$bin/helm"
install -m 0755 "$tmp/kubectl" "$bin/kubectl"
"$bin/kind" version && "$bin/helm" version --short && "$bin/kubectl" version --client | head -n 1
