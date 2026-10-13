# VUH-2141 remote lead restart proof

A running standalone remote bridge recovered its catalog and channel after the
scratch HTTP runtime stopped for 6.006 seconds and returned at a new loopback
address. Catalog recovery took 1.744 seconds after the new address was published;
channel recovery took 1.794 seconds. These are observation timings, including the
assertion polling interval, rather than a promised reconnect deadline.

The original stdio bridge process and bearer stayed alive. No client catalog
request, relaunch, credential refresh or owner action drove recovery. The new
runtime loaded the persisted delegation and original native proof. Its channel
then delivered a wake; a later tool call executed once. Replacement native
lifetimes and explicit revocation still refused admission.

## Findings and changes

Current main already persists proven delegations and retries idle bridge loss
(VUH-1980), and preserves connection identity across workspace-grant changes
(VUH-2189). The original October 11 incident was not reproduced on current main.
The former restart regression recreated bridge objects while its TCP listener
stayed open. This proof closes the listener, waits six seconds, creates a new
listener and publishes its address.

A launch that never proved its native process before shutdown previously became
a generic 403 and retried forever. It now returns `remote_lead_launch_unproved`;
the standalone bridge exits with one clear recovery reason and leaves its pane
open. Temporary observation and transport failures retain retries.

Launch receipts now record the selected account label. An omitted label on a
fresh intentional relaunch reuses the last completed launch for that exact
conversation, fleet and workspace. An explicit selection wins. Standard profiles
selected automatically are reported by the bootstrap receipt; credentials and
profile paths are not recorded. Legacy receipts lacking a label cannot supply
one.

Doctor now renders known disconnected and reconnecting bridges, including their
lead chat names in the existing diagnostic text. The fleet round already includes
lead names, receiver state and message availability. The response shape and
stale-bridge summary remain compatible.

## Checks

All commands ran through `clankie heavy --`.

```sh
clankie heavy -- pnpm exec vitest run \
  apps/clankie/test/remote-lead-http.integration.test.ts \
  apps/clankie/test/remote-project-leads.integration.test.ts \
  apps/clankie/test/seat-capabilities.integration.test.ts \
  apps/clankie/test/remote-lead-delegations.test.ts \
  apps/clankie/test/remote-lead-fleet-wakes.integration.test.ts \
  apps/tui/test/doctor-fleet-link.integration.test.ts \
  apps/tui/test/install-doctor.test.ts
```

Exit 0: 7 files, 41 tests passed. The real receipt/launch consumer proves omitted
account reuse. Doctor’s real HTTP client consumes the named disconnect. The
standalone Node bundle consumes the specific unrecoverable refusal and exits with
one line. Existing native replacement, revocation and channel-routing checks pass.

```sh
clankie heavy -- pnpm exec vitest run \
  apps/clankie/test/remote-lead-http.integration.test.ts \
  -t 'the same native head reconnects' --reporter=verbose --silent=false
```

Exit 0: the timing probe passed. The other four cases were deliberately unselected;
they passed in the 41-test run. Formatting passed on all touched files.
The initial focused run had two listener-readiness fixture errors and one stale
summary wording regression; all were corrected before the passing run.

## Scope and remaining live proof

This is a scratch HTTP/MCP runtime restart and filesystem-persistence proof. Its
Windows native-process observer, SSH relay publication and tool implementation
are fixture seams. It does not prove a real Mac reboot, real SSH reconnection or
KH2’s native Claude acceptance on the PC. No live service restart, remote pane or
remote credential operation ran. Deployment and the real-machine follow-up belong
to the lead. Fixture transports and listeners were closed in teardown.

See [measured evidence](measured.json). Raw check output and the source diff are
attached to the issue through the evidence store.
