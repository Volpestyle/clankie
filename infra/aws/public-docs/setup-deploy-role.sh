#!/usr/bin/env bash
set -euo pipefail

[[ "${1:-}" == provision ]] || {
  echo "Usage: $0 provision" >&2
  exit 2
}

account_id="${AWS_ACCOUNT_ID:?Set AWS_ACCOUNT_ID}"
role_name="${DOCS_DEPLOY_ROLE_NAME:-clankie-docs-deploy}"
bucket_name="${DOCS_BUCKET:?Set DOCS_BUCKET}"
distribution_id="${DOCS_DISTRIBUTION_ID:?Set DOCS_DISTRIBUTION_ID}"
repository="${DOCS_DEPLOY_REPOSITORY:?Set DOCS_DEPLOY_REPOSITORY to owner/repo}"
[[ "$account_id" =~ ^[0-9]{12}$ && "$role_name" =~ ^[[:alnum:]_+=,.@-]+$ &&
   "$bucket_name" =~ ^[a-z0-9][a-z0-9.-]+$ && "$distribution_id" =~ ^[A-Z0-9]+$ &&
   "$repository" =~ ^[[:alnum:]_.-]+/[[:alnum:]_.-]+$ ]] || {
  echo "Invalid docs deployment configuration" >&2
  exit 2
}
[[ "$(aws sts get-caller-identity --query Account --output text)" == "$account_id" ]] || {
  echo "AWS credentials do not belong to AWS_ACCOUNT_ID" >&2
  exit 1
}
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
        "token.actions.githubusercontent.com:sub": "repo:${repository}:ref:refs/heads/main"
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
    --description "Deploy public docs from ${repository} main" \
    --assume-role-policy-document "file://$temp_dir/trust.json" >/dev/null
fi
aws iam put-role-policy \
  --role-name "$role_name" \
  --policy-name clankie-docs-deploy \
  --policy-document "file://$temp_dir/policy.json"

aws iam get-role --role-name "$role_name" --query 'Role.Arn' --output text
