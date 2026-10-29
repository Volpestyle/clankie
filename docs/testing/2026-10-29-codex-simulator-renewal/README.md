# Codex simulator renewal — VUH-2969

Baseline: `caf627f44b9f51d9568c2fa54b0fda1ba39630d5`.

Two causes: the heavy-work lookup rejected pane labels against canonical terminal
IDs before checking ancestry; restarted services could not observe surviving
Codex holders because native-task reads required a launch controller in memory.

Raw captures are in `source-captures.tar` in [the evidence manifest](./evidence.json):
`clankie://evidence/sha256/2dbf1b4c5b9e8f74832c291c48af095f2aac1fa11bbb48ac85794dae41dac864`.

## Focused source proof

All commands ran through `clankie heavy` with a scratch HOME. Native harness and
simctl protocol fixtures are surrogates; HTTP, sockets, durable governor state,
request-process ancestry and CLI paths are real. These checks do not establish
real CoreSimulator or deployed-service behavior.

- `red.log`: tests added against unchanged baseline source; all four selected
  regressions failed (restarted native holder unavailable; three pane-labelled
  heavy-queue cases expired).
- `green.log`: 32 tests passed across Codex hired-seat protocol, resource wait
  liveness and external status integration. Includes exact root/descendant,
  idle sibling, foreign/cyclic ancestry, queued/held permits, copied-label denial
  and the idle-still-expires control.
- `server-green.log`: additional pane-labelled Codex server retention and idle
  expiry control passed.
- `reconnect-green.log`: restarted holder check passed, including occupant change
  during the native read and unloaded-root denial. No start/resume RPC is used.

Focused command: `clankie heavy -- env HOME=<scratch> pnpm exec vitest run
apps/clankie/test/codex-hired-seat-protocol.integration.test.ts
apps/clankie/test/resource-wait-liveness.integration.test.ts
apps/clankie/test/external-codex-status.integration.test.ts`.

## Separate acquire stall

`juno-*.json` are copies of Juno's saved 03:24–03:29Z captures, restricted to her
Codex holder. They show reserved → created → release held, then a different lease
booted. The pre-boot stall is below the ten-minute idle window. VUH-2970 tracks
its unresolved cause separately; this renewal fix makes no boot-stall claim.

## Live proof

Pending deployment by Clankie after exact-patch review and the landing gate.
No service restart was performed by this worker. Real >10-minute turn/queue
retention and prompt-idle expiry are still required.
