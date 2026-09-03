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
    alarm_email="${CLANKIE_ACCOUNT_ALARM_EMAIL:-}"
    [[ "$alarm_email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || {
      echo "Set CLANKIE_ACCOUNT_ALARM_EMAIL to the address that receives the SES send-volume alarm" >&2
      exit 2
    }
    send_alarm_per_hour="${CLANKIE_ACCOUNT_SEND_ALARM_PER_HOUR:-200}"
    [[ "$send_alarm_per_hour" =~ ^[1-9][0-9]*$ ]] || {
      echo "CLANKIE_ACCOUNT_SEND_ALARM_PER_HOUR must be a positive integer" >&2
      exit 2
    }
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
        "EmailFrom=$email_from" \
        "AlarmEmail=$alarm_email" \
        "SendAlarmThresholdPerHour=$send_alarm_per_hour"
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
  ses-status)
    # Everything App Review and external testers depend on, in one read.
    sending_domain="${CLANKIE_ACCOUNT_SENDING_DOMAIN:-clankie.bot}"
    aws sesv2 get-account \
      --region "$region" \
      --query '{ProductionAccess:ProductionAccessEnabled,SendingEnabled:SendingEnabled,Max24HourSend:SendQuota.Max24HourSend,ReviewStatus:Details.ReviewDetails.Status}' \
      --output table
    aws sesv2 get-email-identity \
      --region "$region" \
      --email-identity "$sending_domain" \
      --query '{Identity:`'"$sending_domain"'`,VerifiedForSending:VerifiedForSendingStatus,DkimStatus:DkimAttributes.Status,DkimCnames:DkimAttributes.Tokens}' \
      --output table
    ;;
  ses-production)
    # Opens the SES production-access case for this region. AWS answers within
    # about 24 hours; `ses-status` shows ProductionAccess true when granted.
    contact="${CLANKIE_ACCOUNT_ALARM_EMAIL:-}"
    [[ "$contact" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || {
      echo "Set CLANKIE_ACCOUNT_ALARM_EMAIL to the address AWS may contact about the request" >&2
      exit 2
    }
    # The use case is the case reply itself (everything after the rule), so the
    # API request and the Support Center answer never drift apart.
    use_case="$(awk 'found { print } /^---$/ { found = 1 }' infra/aws/accounts/ses-production-case.md)"
    aws sesv2 put-account-details \
      --region "$region" \
      --production-access-enabled \
      --mail-type TRANSACTIONAL \
      --website-url https://clankie.bot \
      --contact-language EN \
      --additional-contact-email-addresses "$contact" \
      --use-case-description "$use_case"
    echo "Production access requested; poll with: $0 ses-status"
    ;;
  disable)
    # A bounced or complaining address: no further mail, and its Mac loses remote access.
    email="${2:-}"
    [[ "$email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]] || {
      echo "Usage: $0 disable person@example.com" >&2
      exit 2
    }
    aws cognito-idp admin-disable-user \
      --region "$region" \
      --user-pool-id "$(stack_output UserPoolId)" \
      --username "$email"
    echo "Disabled: $email"
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
    echo "Usage: $0 provision|config|ses-status|ses-production|invite person@example.com|disable person@example.com" >&2
    exit 2
    ;;
esac
