# Mac companion service setup — VUH-1728 / VUH-1729

Nico's service handoff on 2026-10-06, branch `nico/mac-service-setup`, based on
`origin/main` at `2e1c08be`. Ready for lead integration; no app, installer or
signed-distribution changes. Scope follows
[VUH-1726](https://linear.app/vuhlp/issue/VUH-1726),
[VUH-1728](https://linear.app/vuhlp/issue/VUH-1728) and
[VUH-1729](https://linear.app/vuhlp/issue/VUH-1729).

## Outcome

- Owner-only IPC minting and private single-use handoff, then native loopback
  redemption. Reinstall and service restart reuse the active companion device;
  revoked identities never revive. Typed contract:
  [local-companion](../../../packages/protocol/src/local-companion.ts);
  [consumer guide](../../local-companion.md).
- Device sign-in methods/start/status/cancel reuse the existing ChatGPT and
  SuperGrok helpers. Successful sign-in writes broker credentials and selects
  the chosen catalog model. First-run device key entry closes on self-hosted
  Mac readiness, including operator-seat readiness; operator key management and
  hosted behavior are preserved. Typed contract:
  [model-keys](../../../packages/protocol/src/model-keys.ts);
  [consumer guide](../../model-keys.md).
- Readiness remains the shared broker/config-backed answer. No independent app
  setup flag, service restart or policy exception for Claude subscription login.

## Verification

All memory-heavy commands used the fleet `heavy` wrapper. Dependencies were
installed in this worktree with `pnpm install --frozen-lockfile`; no shared
`node_modules` or cache symlinks, simulators, evals or full-suite runs.

| Gate                   | Observed result                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------- |
| Focused tests          | **107 passed / 8 files**, 2026-10-06 09:20 UTC, 15.04 seconds                           |
| Types                  | `@clankie/clankie`, `@clankie/tui`, `@clankie/protocol`, `@clankie/model-provider` pass |
| Lint                   | Changed TypeScript files pass `oxlint --deny-warnings`                                  |
| Public docs            | Generated API/network/CLI references pass `@clankie/docs check`                         |
| Local doc links        | `check-doc-links.mjs` passes                                                            |
| Native security review | `/root/security_review` approved final delta; no remaining blockers                     |

Focused command:

```sh
pnpm exec vitest run --config vitest.config.ts \
  apps/clankie/test/mac-companion.integration.test.ts \
  apps/clankie/test/device-subscriptions.integration.test.ts \
  apps/clankie/test/model-keys.test.ts \
  apps/clankie/test/pairing.test.ts \
  apps/clankie/test/direct-pairing.test.ts \
  apps/tui/test/pairing.test.ts \
  packages/model-provider/test/openai-codex.test.ts \
  packages/model-provider/test/xai-oauth.test.ts
```

The new integration cases exercise real HTTP listeners, a protected Unix
socket, private files, event replay, device signatures, browser callbacks,
PKCE exchange, the file credential broker, config writes and strict response
schemas. Synthetic provider responses isolate our boundary. They prove
single-use/concurrent redemption, browser/foreign-Host/forwarding/remote-door
refusal, chunked requests, reinstall/restart reuse, revocation, shared readiness,
first-run closure, hosted compatibility, sign-in isolation, cancellation,
timeout and non-cancellable admitted commits. Real provider consent is untested.
Raw local check output stays in this worktree's ignored `.local/`.

## Security review resolutions

The independent native reviewer identified three issues and approved their
fixes: operator bearer exposure to an impersonated loopback TCP listener,
cancellation racing a broker write, and raw Hono error logging. Minting now uses
a service-owned Unix socket discovered in the same-UID private companion
subtree. The CLI verifies canonical paths, directory/file permissions, socket
ownership and trusted ancestor ownership before sending the bearer. Existing
owned `0755` state roots work; writable or foreign-owned ancestors do not.

Sign-in commit admission reports `committing`, clears the pending deadline and
holds setup/device locks until broker write and model selection finish. Cancel
never reports a committed credential as cancelled. Credential routes have a
static, secret-free error handler. Foreign browser callbacks cannot terminate
an owner's pending sign-in.

## Remaining integration

The app agent consumes the typed handoff/readiness/sign-in APIs. Its file reader
must verify same-UID ownership, mode, bounded size and no symlink following,
remove a redeemed handoff, store the device token securely, open the returned
browser URL, and reflect `committing` during admitted writes. ChatGPT browser
callbacks stay on this Mac; phone setup uses the device method.

VUH-1727 and VUH-1730 remain distribution-blocked. No signed-app fresh install,
pet UI, live provider consent or phone end-to-end capture was run. Claude
subscription login remains removed by the existing service policy; this ticket
adds no exception. The lead owns landing and moving both service tickets to Done.
