#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

bash -n infra/aws/accounts/deploy.sh
aws cloudformation validate-template \
  --region "${CLANKIE_AWS_REGION:-us-east-1}" \
  --template-body file://infra/aws/accounts/template.yaml >/dev/null

if CLANKIE_ACCOUNT_SELF_SIGNUP=invalid infra/aws/accounts/deploy.sh provision >/dev/null 2>&1; then
  echo "Invalid self-sign-up configuration was accepted" >&2
  exit 1
fi
