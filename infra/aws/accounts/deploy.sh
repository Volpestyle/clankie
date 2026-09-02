#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

stack_name="${CLANKIE_ACCOUNTS_STACK:-clankie-accounts}"
region="${CLANKIE_AWS_REGION:-us-east-1}"
command_name="${1:-}"

stack_output() {
  aws cloudformation describe-stacks \
    --region "$region" \
    --stack-name "$stack_name" \
    --query "Stacks[0].Outputs[?OutputKey==\`$1\`].OutputValue | [0]" \
    --output text
}

case "$command_name" in
  provision)
    self_signup="${CLANKIE_ACCOUNT_SELF_SIGNUP:-false}"
    [[ "$self_signup" == true || "$self_signup" == false ]] || {
      echo "CLANKIE_ACCOUNT_SELF_SIGNUP must be true or false" >&2
      exit 2
    }
    sending_domain="${CLANKIE_ACCOUNT_SENDING_DOMAIN:-clankie.bot}"
    [[ "$sending_domain" =~ ^[[:alnum:]][[:alnum:].-]*\.[[:alpha:]]{2,}$ ]] || {
      echo "CLANKIE_ACCOUNT_SENDING_DOMAIN must be a domain" >&2
      exit 2
    }
    email_identity="${CLANKIE_ACCOUNT_EMAIL_IDENTITY:-}"
    [[ "$email_identity" =~ ^([^[:space:]@]+@)?[[:alnum:]][[:alnum:].-]*\.[[:alpha:]]{2,}$ ]] || {
      echo "Set CLANKIE_ACCOUNT_EMAIL_IDENTITY to a verified Amazon SES email or domain identity" >&2
      exit 2
    }
    email_from="${CLANKIE_ACCOUNT_EMAIL_FROM:-$email_identity}"
    [[ "$email_from" =~ ^[^[:space:]@]+@[[:alnum:]][[:alnum:].-]*\.[[:alpha:]]{2,}$ ]] || {
      echo "CLANKIE_ACCOUNT_EMAIL_FROM must be an email address" >&2
      exit 2
    }
    if [[ "$email_identity" == *"@"* ]]; then
      [[ "$email_from" == "$email_identity" ]] || {
        echo "An email identity can send only from that exact address" >&2
        exit 2
      }
    else
      from_domain="${email_from##*@}"
      [[ "$from_domain" == "$email_identity" || "$from_domain" == *".$email_identity" ]] || {
        echo "CLANKIE_ACCOUNT_EMAIL_FROM must belong to the verified domain identity" >&2
        exit 2
      }
    fi
    verified="$(aws sesv2 get-email-identity \
      --region "$region" \
      --email-identity "$email_identity" \
      --query VerifiedForSendingStatus \
      --output text)"
    [[ "$verified" == True ]] || {
      echo "Amazon SES identity is not verified: $email_identity" >&2
      exit 1
    }
    aws cloudformation deploy \
      --region "$region" \
      --stack-name "$stack_name" \
      --template-file infra/aws/accounts/template.yaml \
      --parameter-overrides \
        "SendingDomain=$sending_domain" \
        "SelfSignUpEnabled=$self_signup" \
        "EmailSourceIdentity=$email_identity" \
        "EmailFrom=$email_from"
    aws cloudformation describe-stacks \
      --region "$region" \
      --stack-name "$stack_name" \
      --query 'Stacks[0].Outputs' \
      --output table
    ;;
  config)
    jq -n \
      --arg endpoint "$(stack_output Endpoint)" \
      --arg issuer "$(stack_output Issuer)" \
      --arg client_id "$(stack_output ClientId)" \
      --arg self_signup "$(stack_output SelfSignUpEnabled)" \
      '{schemaVersion: 1, account: {provider: "cognito_email_otp", endpoint: $endpoint, issuer: $issuer, clientId: $client_id, selfSignUpEnabled: ($self_signup == "true")}}'
    ;;
  invite)
    email="${2:-}"
    [[ "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || {
      echo "Usage: $0 invite person@example.com" >&2
      exit 2
    }
    user_pool_id="$(stack_output UserPoolId)"
    if ! aws cognito-idp admin-create-user \
      --region "$region" \
      --user-pool-id "$user_pool_id" \
      --username "$email" \
      --user-attributes "Name=email,Value=$email" Name=email_verified,Value=true \
      --message-action SUPPRESS \
      --output json; then
      aws cognito-idp admin-get-user \
        --region "$region" \
        --user-pool-id "$user_pool_id" \
        --username "$email" \
        --output json >/dev/null
      echo "Account already exists: $email"
    fi
    ;;
  *)
    echo "Usage: $0 provision|config|invite person@example.com" >&2
    exit 2
    ;;
esac
