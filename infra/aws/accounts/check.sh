#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

bash -n infra/aws/accounts/deploy.sh
ruby -e 'require "yaml"; Psych.parse_file(ARGV.fetch(0))' infra/aws/accounts/template.yaml

if CLANKIE_ACCOUNT_SELF_SIGNUP=invalid infra/aws/accounts/deploy.sh provision >/dev/null 2>&1; then
  echo "Invalid self-sign-up configuration was accepted" >&2
  exit 1
fi

if CLANKIE_ACCOUNT_EMAIL_IDENTITY=clankie.bot CLANKIE_ACCOUNT_EMAIL_FROM=invalid \
  infra/aws/accounts/deploy.sh provision >/dev/null 2>&1; then
  echo "Invalid account sender address was accepted" >&2
  exit 1
fi

if CLANKIE_ACCOUNT_EMAIL_IDENTITY=clankie.bot CLANKIE_ACCOUNT_EMAIL_FROM=no-reply@example.com \
  infra/aws/accounts/deploy.sh provision >/dev/null 2>&1; then
  echo "Sender outside the verified identity was accepted" >&2
  exit 1
fi
