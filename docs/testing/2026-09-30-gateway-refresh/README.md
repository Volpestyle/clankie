# Gateway refresh recovery — VUH-1451

The fake gateway reconnects after an offline wake and a lost token rotation
without requiring sign-in. No live Clankie account sign-in/out, account credential read
or write, Keychain mutation, service restart, push, or ops edit was performed.
The account stack was read only to confirm the 60-second rotation grace.

## Evidence

[Focused test output](evidence/focused-tests.log): **43 tests passed in 3 files**.

```sh
pnpm exec vitest run packages/credential-broker/test/account-credential.test.ts apps/clankie/test/public-gateway-connector.test.ts apps/tui/test/install-doctor.test.ts --reporter=verbose
```

- A fake sleeping network refuses Cognito reachability probes. No refresh POST
  occurs; the connector backs off. Once reachable, it reconnects with the new
  access token after losing the first rotation reply.
- Separate fake-clock cases lose either the response or its body after rotation.
  Concurrent callers share one recovery; the same refresh token is retried at
  10.25 seconds, within the simulated server's 60-second grace. The replacement
  is persisted and later calls reuse the fresh access token.
- Persistent transport errors and untyped HTTP 503 stop after four attempts,
  preserve the credential, and remain retryable. A timer resumed after the
  recovery deadline does not issue another fast retry.
- Rate limiting remains `rate_limited`; explicit rejection remains terminal.
  The connector emits `sign_in_required` once. The existing doctor test proves
  the owner sees the sign-in remediation and timestamp outside the service log.

The broker and service package typechecks, owned-file oxlint, and `pnpm docs:check`
also passed. Formatting uses oxfmt.

## Full gate

`pnpm check` was run. Its [output](evidence/check.log) stopped at oxfmt because
another worker's in-progress `scripts/evals/cases.mjs` and `isolation.mjs` were
unformatted. After that worker formatted them, a [second run](evidence/check-final.log)
stopped on in-progress direct-fallback formatting in `apps/clankie/src/app.ts` and
`packages/settings/src/relay-resolve.ts`. Both owners were notified; their files
were left untouched.

The menu-retirement worker's concurrent full run reached the test suite:
359 files passed, with 3,085 tests passed and 2 skipped; the sole failure was the
pre-fix HTTP 429 case. The focused output above proves that case subsequently
passed. Its [gate summary](evidence/shared-check-summary.log) is retained as an
excerpt of `/tmp/vuh-1455-check.log`; it is evidence for that earlier shared tree,
not a claim that all workers' later edits passed. The Rust tests and Vox smoke
steps after the failing Vitest command were not reached by that run. This record
does not claim a successful full repository gate.

## Behavior and limits

Startup derives the gateway route from stored account identity without a
network refresh; the connector owns token resolution and reconnect backoff.
Before spending a refresh token, the broker probes the same account endpoint
with an unauthenticated HEAD. Lost replies and HTTP 5xx get up to three retries
at 250, 500, and 1,000 ms, with ten-second request timeouts and a 50-second
wall-clock recovery deadline. Received rotations are persisted before access
validation. Terminal rejection parks the connector and exposes its existing
owner-facing status once.

These are deterministic fakes and a loopback WebSocket server, not a physical
sleep/wake or live Cognito rehearsal. A process that sleeps through the complete
grace window cannot recover a replacement token whose response was lost. The
owner must re-sign in if the stored credential is already rejected; this change
cannot resurrect it. The lead owns push and restart.
