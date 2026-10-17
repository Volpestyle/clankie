# VUH-2141: remote-lead restart recheck

Tracks: [VUH-2141](https://linear.app/vuhlp/issue/VUH-2141).
Ash tested fetched `origin/main` at `cc2eb50e57c28b89f3979adf68d3965fb8615989`.
The run completed on 2026-10-17 UTC (the October 16 overnight assignment).

The remote-lead bridge already recovers in the local restart regression. No
product or test changes were needed. This coverage predates VUH-1800:
`9de66a3e054958474f2ccae133719f9bede9f07f` landed the remote-lead restart proof,
diagnostics and account reuse on October 13. VUH-1800's
`7f82f26459db8cf0607f31787a464e6a5b23ee75` changes the separate installed
joined-machine client, not the no-install SSH remote-lead bridge.

## Observed result

The existing `remote-lead-http.integration.test.ts` case, “the same native head
reconnects after proof loss and restart, but replacement and revoke never rearm”,
ran the bundled standalone bridge as a real Node child with MCP over stdio and
loopback HTTP. It closed the HTTP listener and connections, waited six seconds,
recreated the delegation store and outbox from disk, then published a new address.

- Listener downtime: 6.004 seconds.
- Automatic catalog recovery after publication: 1.729 seconds.
- Automatic channel recovery after publication: 1.780 seconds.
- The same child and bearer survived; no catalog reads, relaunch or token refresh
  drove recovery during the outage. The original conversation received a wake,
  and a subsequent tool call executed once.
- Temporary proof loss recovered. Changed pane, session and process lifetimes,
  conversation mismatch, and persisted revocation still refused authority.
- The unproved-launch case exited with one clear reason rather than retrying
  indefinitely. The real launch/receipt consumer reused the recorded account
  label; doctor consumed the named disconnected-bridge diagnostic.

Timings include assertion polling and are observations, not promised deadlines.

## Checks

All tests and dependency installation ran through `clankie heavy --`:

```sh
clankie heavy -- pnpm exec vitest run \
  apps/clankie/test/remote-lead-http.integration.test.ts \
  apps/clankie/test/remote-project-leads.integration.test.ts \
  apps/clankie/test/remote-lead-delegations.test.ts \
  apps/clankie/test/remote-lead-fleet-wakes.integration.test.ts \
  apps/tui/test/doctor-fleet-link.integration.test.ts \
  apps/tui/test/install-doctor.test.ts --reporter=verbose
```

Exit 0: 6 files, 38 tests passed. The initial invocation failed before tests
because this fresh worktree lacked `vitest`; a frozen-lockfile install succeeded,
then the command above passed. Raw logs are retained in `evidence.json`.

## Gaps and closure

This repeats and confirms the [October 13 fixture proof](../2026-10-13-remote-lead-restart/README.md).
It does not establish whether a KH2 head was running during the October 15
disconnect reported in the issue history. Native Windows observation, SSH relay
publication, and tool implementation are fixture seams; this is not a real Mac
reboot, SSH reconnection, or native Claude acceptance on the PC.

No shared service restart, PC access, deployment or release was performed.
Kit and Lark were notified of this evidence-only scope. The lead can accept this
assignment's local restart result; the issue's separate live restart and reboot
acceptance remains unproven and must remain explicit in any closure decision.
