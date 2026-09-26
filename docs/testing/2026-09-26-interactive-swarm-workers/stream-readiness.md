# Stream dispatch readiness — VUH-1380

Upstream implementation: [`dff68e3`](https://github.com/Volpestyle/swarm-mcp/commit/dff68e3).
This is the current stream worker, independent of interactive-channel consent.
It is installed and live after the reviewed, drained upgrade on 2026-09-26.

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

The upstream regression tests use disposable coordinators, a fake Herdr topology
and a protocol-only Claude fixture. The subsequent live smoke test below also
used an actual Claude worker. Existing-peer and OpenCode
providers retain their previous protocols. Database schema remains 14.

## Rollout boundary

Live worker `98a9b917` was reported during implementation. No package install,
live owner restart or artifact replacement was performed while it was active.
The lead owns the review, dispatch hold and drain confirmation. Automated install
locking and immutable runtime generations remain separate work; this implementation
does not claim they exist. A timeout or closed pane is not proof a worker stopped.

## Installed rollout and live proof

After the lead confirmed task `98a9b917` released and all worker wrappers stopped,
preflight verified no active tasks in either coordinator and no `herdr-worker-cli`
process. Fresh SQLite online backups of both scopes passed `integrity_check`.
The four older incident tasks had already been recovered to terminal cancellation;
their historical dispatch receipts remain retained, with the lead's process-stop
proof recorded in the private handoff log.

The candidate was packed from a clean detached checkout at `dff68e3`, installed
with the frozen lockfile, and the captain plus its two scoped owners restarted.
No eval/test owners were stopped. Both running owners now report schema 14,
revision `dff68e3a8e42e8b1cb479b9c10722a1b0f2cacfe`, and source digest
`e685dbf61c7e2e239edaebef381a8ee3cf7f8ac11f79a57756e47ac0a4c331da`.
The artifact SHA-256 is
`b276e0346038a7912718b3aab9f89ffcc99dd60b207138ee26dad65eef55f8b6`.
Runtime workspaces were preserved; budget and capacity both remained default 16.

A new read-only Claude stream task `35c34f1d-5f41-4784-be13-4b59d75ecb30`
returned `bound` in **8,126 ms**, with attempt
`df5f26b9-281a-48da-a525-36f2b260d4dd`, fence 1. Its worker MCP health was
`ready` for the same enrolled session/generation. The worker completed the task;
the probe reservation was released and its owned pane closed. No probe worker
was left running.

The six installed Swarm package/release tests passed. Full `pnpm check` passed
formatting and lint but stopped at the unrelated Knip finding
`docs/testing/2026-09-26-hosted-connections/flows/serve.mts` (unused file).
The captain needed the launcher's SIGKILL escalation after its graceful-stop
window; startup then reported captain, relay and Discord healthy. Activity and
tunnel were left running. That shutdown limitation remains separate from dispatch
readiness and is included in the lead handoff.
