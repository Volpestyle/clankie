#!/usr/bin/env bash
set -euo pipefail

[[ "${1:-}" == provision ]] || {
  echo "Usage: $0 provision" >&2
  exit 2
}

account_id=842434829012
role_name=clankie-docs-deploy
bucket_name=clankie-bot-docs
distribution_id=E2SL4SXV9RAPNU
oidc_provider="arn:aws:iam::${account_id}:oidc-provider/token.actions.githubusercontent.com"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT

cat >"$temp_dir/trust.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Federated": "${oidc_provider}"},
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:Volpestyle/clankie:ref:refs/heads/main"
      }
    }
  }]
}
JSON

cat >"$temp_dir/policy.json" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket"],
      "Resource": "arn:aws:s3:::${bucket_name}"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:DeleteObject", "s3:GetObject", "s3:PutObject"],
      "Resource": "arn:aws:s3:::${bucket_name}/*"
    },
    {
      "Effect": "Allow",
      "Action": "cloudfront:CreateInvalidation",
      "Resource": "arn:aws:cloudfront::${account_id}:distribution/${distribution_id}"
    }
  ]
}
JSON

aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$oidc_provider" >/dev/null
if aws iam get-role --role-name "$role_name" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$role_name" --policy-document "file://$temp_dir/trust.json"
else
  aws iam create-role \
    --role-name "$role_name" \
    --description "Deploy docs.clankie.bot from Volpestyle/clankie main" \
    --assume-role-policy-document "file://$temp_dir/trust.json" >/dev/null
fi
aws iam put-role-policy \
  --role-name "$role_name" \
  --policy-name clankie-docs-deploy \
  --policy-document "file://$temp_dir/policy.json"

aws iam get-role --role-name "$role_name" --query 'Role.Arn' --output text
