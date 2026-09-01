#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

bash -n infra/aws/public-gateway/deploy.sh infra/aws/public-gateway/activate-release.sh
[[ "$(infra/aws/public-gateway/activate-release.sh --version)" == 1 ]]
jq -e . infra/aws/public-gateway/tailnet-policy.fragment.hujson >/dev/null

if CLANKIE_AWS_REGION=test CLANKIE_GATEWAY_KEY_PAIR_NAME=test CLANKIE_GATEWAY_PUBLIC_SSH=invalid \
  infra/aws/public-gateway/deploy.sh provision >/dev/null 2>&1; then
  echo "Invalid public SSH configuration was accepted" >&2
  exit 1
fi
