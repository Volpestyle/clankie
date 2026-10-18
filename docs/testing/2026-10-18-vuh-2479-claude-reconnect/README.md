# VUH-2479: a live Windows Claude worker after an update and runtime deploy

Tracks: https://linear.app/vuhlp/issue/VUH-2479

The failure came from Windows native process admission. The worker kept running
an image renamed to `claude.exe.old.<timestamp>.<updater-pid>`, but the observer
required the suffix to equal the worker's own PID. Several workers can share
that image. The fix retains the installed launcher anchor, lifetime-bounded
rename timestamp, fresh native PID/birth, pane ancestry and socket ownership;
it accepts a valid updater PID independently of the worker PID.

## Read-only diagnosis

- The affected worker started at 21:42:57Z; its image was renamed at 22:34:26Z.
- Its retained native journal records a refused report at 23:25:58Z. The actual
  service shutdown was later, at 23:27:54Z, and the PC link was ready at 23:28:08Z.
- The bridge was alive and connected to the replacement fleet port. The installed
  runtime's native observer returned no native process; readoption could not
  repair that admission failure. Connected Linear tools use separate admission.
- The affected bridge advertised plugin 0.6.19. The observed 0.6.18 bridge belonged
  to another pane. Updating plugin files cannot repair a server-side image check.
- The unmodified base matcher rejected the captured loaded-image path; the fixed
  production PowerShell matcher accepted it.
- Running the fixed production observer read-only on the PC recognized the same
  worker in both snapshots. The complete source observer also proved its exact
  existing bridge TCP socket, native process birth, pane ancestry and workspace.

The source proof ran over authenticated SSH. An installed `clankie agents read`
through the fleet failed with "No recent agent session"; the original journal
was then read over SSH. Doctor and connection reads used the installed fleet.
No messages, terminal input, interruptions, restarts, config writes or files
were sent to Ivo or its pane. Raw journals and host details remain private under
`.local/vuh-2479/`; `proof-summary.json` contains the sanitized observations.
The failed binding lookup happened before the bridge created an outbound
receipt; the PC inbound-receipt directory was empty. The one retained channel
delivery was the original hiring brief, acknowledged before the image update.

## Regression checks

The Windows integration test executes the production predecessor function in
real PowerShell over authenticated SSH. It covers equal and different updater
PIDs and refuses another directory/launcher, a pre-birth/future rename, an extra
or nested suffix, and zero, negative, overflowing or nonnumeric updater PIDs.
This test requires the explicit `WINDOWS_CLAUDE_PROOF_HOST` environment variable;
it is skipped on ordinary landing runs without that Windows host.

The bridge integration test starts the real Claude stdio bridge, mailbox,
HTTP routes, receipt store and WorkerMcp. After a completed channel delivery,
it disposes the old runtime's HTTP listener and in-memory sessions/mailbox,
starts a fresh runtime and republishes the link. The same bridge rebinds,
receives the next message with an exact ACK, and has one report durably accepted.
This is an integration proof of the bridge/HTTP/mailbox/receipt boundaries;
it does not run Claude Code or replace the live PC runtime.

Commands (all governed):

```sh
clankie heavy -- env WINDOWS_CLAUDE_PROOF_HOST=HOST pnpm exec vitest run apps/clankie/test/windows-claude-predecessor.integration.test.ts
clankie heavy -- pnpm exec vitest run apps/clankie/test/worker-bridge-health.integration.test.ts
clankie heavy -- pnpm check:landing
```

The commit and final check results are recorded on the issue.
The root gate report is `.local/landing-gate.json` in this worktree.

## Deployment and recovery still open

The fix is server-side and requires the lead's scheduled runtime deploy/restart.
No restart was performed for this investigation. The current bridge retries
mailbox failures and should recover once the corrected runtime admits it; the
lead must observe that after deployment. Live report acceptance and model
consumption have not been tested, because touching Ivo's active turn was forbidden.

If its channel polling has stopped on an unresolved receipt, deployment cannot
restart that loop. Once Ivo's turn ends, reconcile the original receipt, then
coordinate `/mcp` reconnect of the worker bridge. If reconnect cannot restore it,
preserve its native session, cwd and account profile and resume with the original
channel-enabled launch. Never replay uncertain originals, start a competing
session or interrupt the active KH2 turn.
