#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

export CLANKIE_ACCOUNT_SENDING_DOMAIN=example.com

bash -n infra/aws/accounts/deploy.sh
ruby -e 'require "yaml"; Psych.parse_file(ARGV.fetch(0))' infra/aws/accounts/template.yaml

if CLANKIE_ACCOUNT_SELF_SIGNUP=invalid infra/aws/accounts/deploy.sh provision >/dev/null 2>&1; then
  echo "Invalid self-sign-up configuration was accepted" >&2
  exit 1
fi

if CLANKIE_ACCOUNT_EMAIL_IDENTITY=example.com CLANKIE_ACCOUNT_EMAIL_FROM=invalid \
  infra/aws/accounts/deploy.sh provision >/dev/null 2>&1; then
  echo "Invalid account sender address was accepted" >&2
  exit 1
fi

if CLANKIE_ACCOUNT_EMAIL_IDENTITY=example.com CLANKIE_ACCOUNT_EMAIL_FROM=no-reply@other.example \
  infra/aws/accounts/deploy.sh provision >/dev/null 2>&1; then
  echo "Sender outside the verified identity was accepted" >&2
  exit 1
fi

if CLANKIE_ACCOUNT_EMAIL_IDENTITY=example.com CLANKIE_ACCOUNT_EMAIL_FROM=no-reply@example.com \
  CLANKIE_ACCOUNT_ALARM_EMAIL=not-an-address infra/aws/accounts/deploy.sh provision >/dev/null 2>&1; then
  echo "Invalid alarm address was accepted" >&2
  exit 1
fi

# SES submission text is supplied privately and passed verbatim, never fabricated.
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
export TEST_CAPTURE="$work"
cat >"$work/aws" <<'AWS'
#!/usr/bin/env bash
printf '%s\n' "$@" >"$TEST_CAPTURE/args"
AWS
chmod +x "$work/aws"
export PATH="$work:$PATH"
export CLANKIE_ACCOUNT_ALARM_EMAIL=operator@example.com
export CLANKIE_ACCOUNT_WEBSITE_URL=https://example.com
export CLANKIE_ACCOUNT_SES_USE_CASE_FILE="$work/use-case.txt"
if infra/aws/accounts/deploy.sh ses-production >/dev/null 2>&1; then
  echo "Missing private SES text was accepted" >&2
  exit 1
fi
printf ' \n\t\n' >"$work/use-case.txt"
if infra/aws/accounts/deploy.sh ses-production >/dev/null 2>&1; then
  echo "Blank private SES text was accepted" >&2
  exit 1
fi
[[ ! -e "$work/args" ]]
printf 'Reviewed deployment-specific submission.\nSecond line.\n' >"$work/use-case.txt"
infra/aws/accounts/deploy.sh ses-production >/dev/null
awk 'found { print } $0 == "--use-case-description" { found = 1 }' "$work/args" >"$work/submitted.txt"
cmp "$work/use-case.txt" "$work/submitted.txt"
grep -Fxq 'https://example.com' "$work/args"
