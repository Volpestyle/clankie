#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

bash -n infra/aws/public-docs/setup-deploy-role.sh

if infra/aws/public-docs/setup-deploy-role.sh >/dev/null 2>&1; then
  echo "Deploy role setup accepted a missing command" >&2
  exit 1
fi

workflow=.github/workflows/docs.yml
script=infra/aws/public-docs/setup-deploy-role.sh
for value in 842434829012 clankie-docs-deploy clankie-bot-docs E2SL4SXV9RAPNU; do
  grep -Fq "$value" "$workflow"
  grep -Fq "$value" "$script"
done
grep -Fq 'repo:Volpestyle/clankie:ref:refs/heads/main' "$script"
