# AWS accounts

Clankie uses one Amazon Cognito Essentials user pool for passwordless Mac
enrollment. The Mac calls Cognito's public JSON API directly, stores its rotating
refresh token in Keychain, and presents one-hour access tokens to the public
gateway. There is no hosted UI, client secret, IAM credential, or account
database in the gateway.

Cognito currently rejects pool creation when `EMAIL_OTP` is the only declared
first factor, so the pool also declares `PASSWORD`. Clankie creates users
without passwords and its public client requests only `EMAIL_OTP`; the product
journey remains passwordless.

```mermaid
sequenceDiagram
  participant User
  participant Mac as Clankie on Mac
  participant Cognito
  participant Gateway
  User->>Mac: enter invited email
  Mac->>Cognito: USER_AUTH / EMAIL_OTP
  Cognito-->>User: one-time email code
  User->>Mac: enter code
  Cognito-->>Mac: access + rotating refresh token
  Mac->>Gateway: installation id + signed access token
  Gateway->>Gateway: verify JWT and derive host route
```

## Provision and invite

```bash
export CLANKIE_AWS_REGION=us-east-1
export CLANKIE_ACCOUNT_EMAIL_IDENTITY=verified-sender@example.com
export CLANKIE_ACCOUNT_ALARM_EMAIL=operator@example.com
infra/aws/accounts/deploy.sh provision
infra/aws/accounts/deploy.sh invite tester@example.com
infra/aws/accounts/deploy.sh config
```

`CLANKIE_ACCOUNT_ALARM_EMAIL` receives the stack's SES send-volume alarm (SNS
sends a subscription confirmation on the first provision; confirm it). The
alarm fires when the account's hourly SES sends exceed
`CLANKIE_ACCOUNT_SEND_ALARM_PER_HOUR` (default 200, one code per sign-in).

The default is an invite-only beta. `invite` suppresses Cognito's admin-created
user message; the tester receives the normal OTP only after entering the email
in Clankie's `/gateway` flow. The command is idempotent for an existing email.
Set `CLANKIE_ACCOUNT_SELF_SIGNUP=true` and provision the same stack when signup
should open to any email address.

Cognito passwordless email OTP requires a verified Amazon SES sender. The stack
owns the `clankie.bot` domain identity and outputs its three Easy DKIM CNAMEs.
On the first deployment, leave the existing verified address active, publish
those CNAMEs as DNS-only records, and wait for the domain identity to report
`SUCCESS`. Then make the production sender active:

```bash
export CLANKIE_ACCOUNT_EMAIL_IDENTITY=clankie.bot
export CLANKIE_ACCOUNT_EMAIL_FROM=no-reply@clankie.bot
infra/aws/accounts/deploy.sh provision
```

The identity and From address are separate because one verified domain covers
every sender at that domain. Cognito Essentials has no identity charge for the
first 10,000 direct monthly active users; SES delivery and later paid tiers
remain separate.

## Leave the SES sandbox

The sandbox delivers only to verified recipients and Cognito's default sender
caps at 50 messages a day, so an invited tester whose address is not verified
never receives a code. Before the first outside tester (TestFlight external
testing included):

```bash
infra/aws/accounts/deploy.sh ses-status        # ProductionAccess, DKIM status, the CNAMEs
infra/aws/accounts/deploy.sh ses-production    # opens the production-access case
```

`ses-status` reads what App Review and testers depend on: the account's
production flag and 24-hour quota, and the `clankie.bot` identity's
`VerifiedForSending` and `DkimStatus`. Publish the three DKIM CNAMEs as
DNS-only records in Cloudflare (proxied records break DKIM lookups) and wait
for `DkimStatus` to read `SUCCESS`. `ses-production` files the request with
the transactional-OTP use case; AWS usually answers within a day, after which
`ses-status` shows `ProductionAccess` true. If `ses-status` already shows
`ReviewStatus DENIED`, do not file again blind: open the case it names in the
AWS Support Center (the Support API needs a paid plan), read the reason, and
reply there with the missing detail; a fresh `ses-production` only helps once
that reason is addressed. Then prove delivery: invite an
address that was never verified in SES, run `/gateway` on a Mac with it, and
confirm the code arrives within a minute.

The user pool has deletion protection and a retained resource policy. Access
tokens last one hour; refresh tokens rotate and last 90 days. Removing or
disabling a Cognito user revokes the account across its Mac installations.
