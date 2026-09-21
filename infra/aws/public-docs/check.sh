#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"
script=infra/aws/public-docs/setup-deploy-role.sh
bash -n "$script"

work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
export TEST_CAPTURE="$work"
cat >"$work/aws" <<'AWS'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >>"$TEST_CAPTURE/calls"
if [[ "$1 $2" == 'sts get-caller-identity' ]]; then
  echo "${TEST_ACCOUNT:-123456789012}"
fi
for arg in "$@"; do
  case "$arg" in
    file://*/trust.json) cp "${arg#file://}" "$TEST_CAPTURE/trust.json" ;;
    file://*/policy.json) cp "${arg#file://}" "$TEST_CAPTURE/policy.json" ;;
  esac
done
AWS
chmod +x "$work/aws"
export PATH="$work:$PATH"
export AWS_ACCOUNT_ID=123456789012 DOCS_BUCKET=example-docs DOCS_DISTRIBUTION_ID=EXAMPLE123
export DOCS_DEPLOY_REPOSITORY=example/project DOCS_DEPLOY_ROLE_NAME=example-docs-deploy

if "$script" >/dev/null 2>&1 || DOCS_BUCKET= "$script" provision >/dev/null 2>&1 ||
   DOCS_DEPLOY_REPOSITORY='bad"repo' "$script" provision >/dev/null 2>&1; then
  echo "Invalid or missing docs configuration was accepted" >&2
  exit 1
fi
[[ ! -e "$work/calls" ]]
if TEST_ACCOUNT=999999999999 "$script" provision >/dev/null 2>&1; then
  echo "Setup accepted credentials for the wrong account" >&2
  exit 1
fi
[[ "$(wc -l < "$work/calls" | tr -d ' ')" == 1 ]]
"$script" provision >/dev/null
jq -e '.Statement[0] | .Principal.Federated == "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com" and .Condition.StringEquals["token.actions.githubusercontent.com:aud"] == "sts.amazonaws.com" and .Condition.StringEquals["token.actions.githubusercontent.com:sub"] == "repo:example/project:ref:refs/heads/main"' "$work/trust.json" >/dev/null
jq -e '[.Statement[].Resource] == ["arn:aws:s3:::example-docs", "arn:aws:s3:::example-docs/*", "arn:aws:cloudfront::123456789012:distribution/EXAMPLE123"]' "$work/policy.json" >/dev/null
for value in AWS_REGION DOCS_BUCKET DOCS_DISTRIBUTION_ID DEPLOY_ROLE_ARN; do
  grep -Fq "vars.$value" .github/workflows/docs.yml
done
