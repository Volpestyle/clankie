# packages/credential-broker/test/discord-user-session-provider.test.ts

User-session provider tests: grants issue and
redeem only under a live matching opt-in; no
opt-in, a revoked opt-in (checked mid-grant, at
redemption), or a different doctrine profile all
refuse with typed codes; allowlist and
resource-coverage violations refuse; a missing
stored user credential refuses.
