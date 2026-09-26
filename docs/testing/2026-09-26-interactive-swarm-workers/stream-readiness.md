# Stream dispatch readiness — VUH-1380

Upstream implementation: [`dff68e3`](https://github.com/Volpestyle/swarm-mcp/commit/dff68e3).
This is the current stream worker, independent of interactive-channel consent.
At this evidence checkpoint it is committed upstream but **not installed** in
Clankie's live runtime. Re-vendoring requires review and a coordinated dispatch hold.

## Behavior and evidence

| Check                                                                 | Observed result                                                                                                                     |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Physical pane/`started`/available session without MCP claim           | Dispatch stays uncertain; no bind-on-behalf claim.                                                                                  |
| Actual mismatched MCP subprocess against the test coordinator         | Typed `coordinator_version_mismatch`, never `bound`, under five seconds with a one-second route readiness deadline.                 |
| Actual wrapper and MCP, protocol harness fixture calling `swarm_sync` | Bound only after authenticated worker claim; the provider and runner read the current attempt/fence back.                           |
| Kill only that fixture's MCP process after binding                    | Wrapper stays alive; lead inbox receives `blocked:mcp_disconnected`; retry stays uncertain and no second pane is launched.          |
| Lost readiness reply                                                  | Same command receipt, task attempt and fence on replay; no second launch.                                                           |
| Wrong enrollment or optimistic provider                               | Readiness rejected; coordinator cannot claim on the pinned worker's behalf.                                                         |
| Lease renewal without progress                                        | Progress deadline does not move; diagnostic `signal: stale_progress` and a creator inbox notice remain available.                   |
| MCP output schema                                                     | `swarm_assign` retains typed reasons, intent/task/token/route and recovery guidance through actual MCP request/response validation. |

Readiness uses the worker enrollment, not the operator bearer. The claim and
assignment envelope commit in one SQLite transaction. A private health record
contains launch token, session/generation, PID, timestamp and sanitized status;
it is not used as a substitute for a claim. The wrapper is the only stream-worker
inbox consumer. Failed or timed-out starts retain capacity and receipts.

The default readiness deadline is 60 seconds (owner route range 1–60 seconds).
Coordinator IPC allows 65 seconds for dispatch; Clankie's routed assignment client
allows 75 seconds so a typed result can arrive before its outer timeout.

## Verification

- Upstream typecheck, 192 Bun tests, Python hook test and production build passed.
- After the final runner read-back guard, 10 focused dispatch/Herdr/readiness tests
  passed; the optimistic-provider refusal regression also passed.
- `npm run verify:package` passed, verifying 57 packaged files and all production entries.
- The aggregate `bun run check` reached package verification but Bun supplied its
  own binary as `npm_execpath`; the verifier tried to run that binary as JavaScript.
  The identical verifier passed when invoked directly with npm.
- Clankie's Swarm package typecheck passed. Full `pnpm check` stopped at unrelated,
  in-progress account/work-items formatting paths; those files were not changed here.

Tests use disposable coordinators, a fake Herdr topology and a protocol-only
Claude fixture. They exercise the real wrapper and MCP process, but do not claim
a fresh live Claude-model dispatch has been tested. Existing-peer and OpenCode
providers retain their previous protocols. Database schema remains 14.

## Rollout boundary

Live worker `98a9b917` was reported during implementation. No package install,
live owner restart or artifact replacement was performed while it was active.
The lead owns the review, dispatch hold and drain confirmation. Automated install
locking and immutable runtime generations remain separate work; this implementation
does not claim they exist. A timeout or closed pane is not proof a worker stopped.
