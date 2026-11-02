# Surviving Codex report admission (#288)

Read-only diagnosis on the Mac, 2026-11-02:

- Original desktop hire record remains present, with the original TUI PID and native session.
- The installed `desktopCodexAdmission` accepts the surviving worker's actual bridge ancestry. The real kernel listener check succeeds, the original TUI endpoint is observed, and the hired session is loaded.
- The service log records `not_member` for that bridge at 03:32:28 UTC, before #289. There are no subsequent requests from that bridge after the restart onto #289.
- `seat-channel.mjs` permanently latches `membershipStopped` after a membership refusal. `inboundRequest` then fabricates a local 403 without contacting the service. This produces the reported error even after service admission has recovered.

Existing running bridges retain loaded JavaScript; deploying a source change alone cannot change their already-latched state.

## Result

Explicit report and original receipt requests now refresh the link and ask the
service to prove current admission. A prior refusal still stops automatic
mailbox/catalog polling. No POST replay or admission checks were relaxed.

The real Codex 0.166.0 proof passed, including an exact accepted delivery replay
from a foreign process being refused with 403. [Receipt](receipt.json) records
the two disposable service PIDs, unchanged native TUI/server/bridge identity,
the rejected report and the two stored reports. Raw local diagnostics are under
`.local/codex-report-proof/` in the task worktree.

The proof starts a private core with scratch HOME, Codex config and every XDG
root. Its disposable report service hires through `createCodexSeatAdapter`,
starts the actual Codex TUI/app-server/worker MCP bridge, rejects a report, then
is killed and replaced. The same native bridge's next explicit report reaches
the new service and is stored. The proof uses production native admission,
listener/ancestry checks, HTTP seat routes and durable `ConversationStore`.
An offline Responses SSE server supplies deterministic native MCP tool calls;
there are no credentials or paid provider calls. Connected account discovery
is off, and captain intake is a stub: this proves durable report acceptance,
not a live lead turn, notification delivery, or the complete production startup.

Commands (all checks ran through `clankie heavy --`):

```sh
CODEX_REPORT_NATIVE_TEST=1 clankie heavy -- pnpm exec vitest run apps/clankie/test/codex-report-native.integration.test.ts
clankie heavy -- pnpm exec vitest run apps/clankie/test/worker-channel-restart.integration.test.ts -t 'reconnects|rechecks'
clankie heavy -- pnpm exec vitest run apps/clankie/test/desktop-codex-hire.integration.test.ts apps/clankie/test/inbound-receipt-boundary.test.ts apps/clankie/test/inbound-report-recovery.integration.test.ts
```

Results: the real-Codex proof passed; three channel restart/readmission checks
passed; 27 desktop/receipt checks passed, retaining #289's foreign-session,
replacement-PID and missing-hire-record refusals. Focused TypeScript, formatting
and lint also passed. The new readmission regression fails with the base bridge
(restored verbatim in an isolated local copy): its post-restart report remains
`rejected` instead of `stored`.

The full channel test file also exposes an existing unknown-ACK notification
count failure. It reproduces with the base bridge and is tracked separately in
[#292](https://github.com/Volpestyle/clankie/issues/292). That failure was not
reported as a passing test or changed here.

The live service and t4j were left untouched. Its existing bridge has already
loaded the old latch; this change cannot replace that running JavaScript. The
lead will verify a fresh worker across a later live restart.
