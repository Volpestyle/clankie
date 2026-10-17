# VUH-2348: OpenCode seat survives one slow context read or model error

## Checks

All checks ran through `clankie heavy --`.

**The real test.** `apps/clankie/test/opencode-seat-resilience.integration.test.ts`
runs the installed OpenCode 1.18.35 `serve` with the shipped seat plugin, launched
by the real `runOpenCodeSeat` bridge. The service is the real in-process Clankie
app and captain. Only the model provider and the memory store are fixtures.
OpenCode and Clankie state live in a temporary home, and the plugin's
`clankie mcp` entry resolves to a shim. The test skips when OpenCode 1.18 is not
installed. It covers three cases:

1. **A stalled context read.** The service stalls the first `/v1/captain/prompt`
   for 11 s, past the client's 10 s bound, during a fresh session's preflight.
   The plugin retries the read and the seat becomes ready, with no stop cause.
2. **A model error.** The provider answers one turn with
   `401 invalid x-api-key`. The turn fails, and the error is recorded as a
   `turn_failed` warning. An owner app turn sent next through
   `/operator/v1/dispatch` reaches the model inside a
   `<clankie-seat-event>`, gets a `delivered` receipt, and the seat keeps no stop
   cause. Every model request carried the service's identity text.
3. **The first stop cause.** Deleting the native session stops the seat with
   `session.deleted`. A follow-on `/failure` report ("Clankie poll failed (409)")
   does not replace it. The close line names `session.deleted`.

## Results

- [The real test passed](real-opencode-passed.txt).
- [Mutations](mutations.txt):
  - With the three source files reverted to `5359af383`, the test fails at step 1.
  - With `session.error` stopping the seat again, it fails at step 2.
  - With `failure =` instead of `??=`, it fails at step 3: the poll refusal
    replaces `session.deleted`.
- [Existing seat tests](existing-seat-tests.txt): `opencode-seat`,
  `seat-isolation` and `opencode-seat-adapter` passed (29 tests).

## Not covered

- No live TUI seat was relaunched, and no shared service was restarted.
- The test drives the native server API rather than the interactive TUI.
