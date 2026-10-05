# Managed Discord directory and owner settings — VUH-1647 / VUH-1689

Code candidate based on Faye's approved VUH-1622 server/role model
(`e1cdf5e9`). No deployment, AWS call, Discord application change, account change,
sign-in, live-service restart, model call or real Discord post is part of this work.

Hosted bodies use the signed managed provider for the shared server/channel/role/
people directory and permission evidence. The provider scopes each request to
the bound tenant, installation and server, retains pagination and partial cache
states, and filters hidden channels/private threads with native Discord rules.
Self-hosted bodies retain their existing local provider.

The body projects its effective policy with an installation, connection generation
and revision fence. Startup and periodic reconciliation retry the current policy
after a conflict or lost receipt. The effective-policy fingerprint includes
environment overrides; the settings snapshot's edit revision still fences the
owner's stored settings. The response exposes `managedPolicy` pending/acknowledged
state rather than claiming a saved setting already reached the edge.

The dashboard uses a purpose-specific, 30-second Ed25519 owner permit bound to
the encrypted request, account, tenant, installation and connection generation.
The body checks a fresh signed, nonce-bound live grant proof before admission
and again at guarded effects/disclosures. Admission is persisted before effects
and replay remains refused after restart. No paired device or terminal grant is
created; gateway/fleet forwarding does not receive Discord credentials.

The account grant is the customer's Discord connection. Disconnect or reinstall
revokes the old generation and stops subsequent admissions. Already admitted
work may finish; Cognito session/logout revocation is a separate boundary.

## Focused evidence

All commands run in the isolated checkout, with no full check or eval:

```sh
pnpm exec vitest run --config vitest.config.ts \
  apps/clankie/test/managed-discord.test.ts \
  apps/clankie/test/discord-settings-definition.test.ts \
  apps/clankie/test/discord-ingress.test.ts \
  apps/clankie/test/hosted-pairing.test.ts \
  apps/clankie/test/public-gateway-connector.test.ts
# PASS: 30/30

pnpm exec vitest run --config vitest.config.ts apps/clankie/test/managed-discord.test.ts
# PASS: 3/3 after canonical effective-policy hashing fix

pnpm exec tsc --noEmit -p apps/clankie/tsconfig.json
pnpm exec tsc --noEmit -p packages/protocol/tsconfig.json
pnpm exec tsc --noEmit -p packages/api-client/tsconfig.json
# PASS; core typecheck repeated after the hashing fix
```

Scoped lint over the 16 changed TypeScript files and `git diff --check` passed.
The new HTTP cases prove encrypted owner settings, foreign owner/installation/
route refusal, signed nonce-bound approval, revocation during a held settings
write, durable replay refusal after restart, failed-admission persistence,
current-disk retry after conflict, and effective environment-policy revisions.

Private ops integration supplies the actual rendered controls and browser
WebCrypto → production Cognito verifier/local RSA-JWKS → fleet HTTP → gateway
WebSocket/connector → body → signed fleet request → edge/SQLite/native cache
journey. It catches reconnect/startup policy serialization mismatches that a
fixture-only HTTP endpoint cannot. No private hosted implementation is added
to the public repository. The companion ops evidence lives at
`clankie-ops/docs/testing/2026-10-05-managed-discord/README.md`.

## Review follow-up: sequence fence

The policy wire now requires a nonnegative safe-integer `sequence` on state,
acknowledgement and conflict responses, plus `expectedSequence` on writes.
The body rereads both revision and sequence after conflict, and persists the
accepted sequence. A legacy local revision-only acknowledgement is discarded
until a fresh wire read; revision-only wire requests/responses fail closed.
The sealed owner bridge, signatures and draft edit revision are unchanged.

Focused follow-up: `managed-discord.test.ts` **4/4 passed**; protocol/core
typechecks, scoped lint and diff check passed. The private real edge HTTP
regression verifies that a delayed R1 → R2 write is refused after R1 → R2 → R1.
Core and ops protocol consumers must land together.

## Owner gates

James owns the disposable dev Discord installation/permission and addressed
message proof, review of the coordinated core/ops release, and any deployment.
Local native cache fixtures do not establish a live Discord OAuth grant, gateway
delivery or production service behavior. No real Discord message is sent by
opening or saving settings in this candidate.
