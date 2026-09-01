#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

bash -n infra/aws/public-gateway/deploy.sh infra/aws/public-gateway/activate-release.sh
[[ "$(infra/aws/public-gateway/activate-release.sh --version)" == 1 ]]
jq -e . infra/aws/public-gateway/tailnet-policy.fragment.hujson >/dev/null

instance_name="$(sed -n 's/^      InstanceName: //p' infra/aws/public-gateway/template.yaml)"
static_ip_name="$(sed -n 's/^      StaticIpName: //p' infra/aws/public-gateway/template.yaml)"
[[ -n "$instance_name" && -n "$static_ip_name" && "$instance_name" != "$static_ip_name" ]] || {
  echo "Lightsail instance and static IP names must be distinct" >&2
  exit 1
}

if CLANKIE_AWS_REGION=test CLANKIE_GATEWAY_KEY_PAIR_NAME=test CLANKIE_GATEWAY_PUBLIC_SSH=invalid \
  infra/aws/public-gateway/deploy.sh provision >/dev/null 2>&1; then
  echo "Invalid public SSH configuration was accepted" >&2
  exit 1
fi
