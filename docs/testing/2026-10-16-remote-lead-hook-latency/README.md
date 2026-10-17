# VUH-2161: bundled hook timing regression

Tracks: [VUH-2161](https://linear.app/vuhlp/issue/VUH-2161).
Based on fetched `origin/main` at `9c3e7eaff40feb6ef436f6606b09711dd00580eb`.
Measured on 2026-10-17 UTC during the October 16 overnight assignment.

The cause was already fixed by `aaffb3d032a1fb487a3e7aed2062200435bd6528`:
each page previously repeated native proofs, each hook replayed history, and
independent ten-second attempts plus retry delays could stall a hook for 37 s.
Current code uses one proof per page, acknowledged-ID checkpoints, and a shared
two-second upload budget. This change adds a regression against the actual
bundled hook and records its local performance; it changes no product code.

## Boundary and result

`apps/clankie/test/remote-lead-hook-latency.integration.test.ts` runs Node hook
children over real loopback HTTP through `createRemoteLeadBridge` and persisted
`RemoteLeadDelegations`, into the real captain and conversation journal. It uses
a synthetic Claude JSONL transcript of 227 records (about 0.7 MB), comparable in
size to the incident. The Windows process proof is a fixture with a deliberate
250 ms observation delay. No native Windows/SSH admission is claimed.

| Hook                            | Child wall time | Hook's own log | HTTP requests |
| ------------------------------- | --------------: | -------------: | ------------: |
| UserPromptSubmit, first backlog |        1,132 ms |         855 ms |             3 |
| PostToolUse, one new record     |          578 ms |         291 ms |             1 |
| Stop, response withheld         |        2,310 ms |       2,005 ms |             1 |
| Stop, response withheld         |        2,377 ms |       2,005 ms |             1 |
| Stop, response withheld         |        2,326 ms |       2,008 ms |             1 |
| Stop, restored response         |          595 ms |         294 ms |             1 |

Successful requests reported authentication at 251.3–264.5 ms (including the
injected delay), and journal writes at 0.8–11.9 ms. The checkpoint avoids another
multi-page proof after the first upload. All 229 records reached the journal,
including the record held locally across three failed hooks. The first two
failures stayed quiet, the third emitted one warning line, and recovery cleared
the failure counter. Logs contain no launch bearer.

The test bounds incremental child wall time below 1.5 s and every child below
3.5 s, including startup. A five-second watchdog makes a broken deadline fail
promptly. These are local regression limits, not PC performance guarantees.

## Regression sensitivity and checks

- The client source before the earlier fix (`49e82a97b005b963351f2c422671e5d5b1131a6c`)
  fails the new test: the incremental hook reuploads three pages instead of one.
  The rest of the service and transcript client remained current in this comparison.
- Deliberately widening only the current client's upload budget to ten seconds
  fails when the first stalled hook hits the five-second watchdog (`SIGKILL`).
- Both comparisons restored the production source byte-for-byte. The original
  test setup initially used extra fields in the strict proof fixture and got
  a 403; that fixture was corrected before the passing measurements.
- Formatting and focused lint ran through `clankie heavy --`. Focused verification:

```sh
clankie heavy -- pnpm exec vitest run \
  apps/clankie/test/remote-lead-hook-latency.integration.test.ts \
  apps/tui/test/seat-sync.test.ts \
  apps/clankie/test/remote-lead-http.integration.test.ts --reporter=verbose
```

Raw passing, pre-fix-client and widened-deadline outputs are retained through
`evidence.json`. The repository-root landing gate is reported on the issue with
its checked revision and base.

Focused result: exit 0, 3 files and 13 tests passed.

## Remaining acceptance

No PC access, shared service restart, deployment, owner credential operation or
model call was performed. Listeners, hook children, captain and scratch files close in teardown.
These measurements do not prove approximately one-second hooks on the PC under
normal fleet load, activation of the staged client in KH2, or an hour without
`consecutiveFailures`. The issue history requires those live observations; they
remain explicit gaps for the lead rather than being inferred from local timing.
