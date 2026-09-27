# VUH-1381: importing the Windows project coordinator

The reverse transport was proven read-only on 2026-09-27
([captured output](transport-proof.txt)). This does **not**
complete criterion 4: enrollment and an acknowledged message round-trip remain
for James and the PC lead. No PC panes were prompted, and no owner, Herdr server,
worker enrollment or file under the PC's `.swarm-mcp` directory was changed.

## Transport proof

Source inspection: `swarm-mcp/src/coordination/ipc.ts` derives the Windows pipe
from SHA-256 of the resolved, lowercase database path (first 24 hex characters).
An allowlisted read of `owner.json.databasePath` returned
`C:\Users\volpe\.swarm-mcp\rivals\coordination.db`. This yields
`\\.\pipe\swarm-mcp-9f4b9b4fcb7f974334faad33`, also present in the running pipe
inventory. The matching owner process was PID 139796, using
`C:\Users\volpe\swarm-mcp-launch\dist\coordination\owner-cli.js` and the
Rivals owner configuration. No launcher secret or capability was printed.

The implementation's `ExternalCoordinatorRelays.endpoint` connected through
`volpe@supedupsilly`, using the fleet's PowerShell command encoder. At
`2026-09-27T20:47:13.599Z`, the resulting Mac socket had mode `0600`. Sending
only `{"id":"vuh1381-read-only","op":"compatibility"}` returned:

```json
{
  "id": "vuh1381-read-only",
  "error": {
    "code": "invalid_input",
    "message": "capability must be nonempty text of at most 512 characters"
  }
}
```

This is the coordinator's framed protocol response, proving both transport
directions. It does not prove authentication, compatibility, inbox admission
or delivery. Closing the relay removed the local socket.

A second run at `2026-09-27T20:54:10.061Z` inspected the remote process and
listener while linked: splice PID 67744 listened only at `127.0.0.1:59363`.
After closing the link, that splice and its listener were absent. Rivals owner
PID 139796 remained running before and after. The second run returned the same
protocol error and again removed the local 0600 socket.

## Prepared enrollment — not executed

The [prepared script](enroll-clankie.mjs) uses the installed launcher's actual
`CoordinationClient` and `enroll` protocol, without `ensureCoordinator` or
`enrollRuntime` (those can start a missing owner). The PC lead must run it in
its **existing Rivals enrolled environment**, with its current `SWARM_SCOPE`
and `SWARM_COORDINATOR_ENDPOINT`. It fails closed if the endpoint differs.
These values belong to that existing session; do not invent a new scope.

1. James transfers the prepared script to the PC (it contains no secrets):

   ```sh
   scp docs/testing/2026-09-27-remote-fleet/connect/enroll-clankie.mjs \
     volpe@supedupsilly:C:/Users/volpe/enroll-clankie.mjs
   ```

2. The PC lead runs this exact command in that enrolled environment:

   ```powershell
   node C:\Users\volpe\enroll-clankie.mjs
   ```

   It reads the launcher credential only within the PC process and sends it only
   to the existing local coordinator. It creates a dedicated Clankie actor with
   a retained enrollment request ID and resume token in the private-ACL directory
   `C:\Users\volpe\.clankie-rivals-peer`, outside `.swarm-mcp`. A retry after an
   uncertain response reuses those IDs. It never resumes a Rivals worker identity.
   The capability is written only to `rivals-connect.json`, never stdout. Keep
   `launcher.json` on the PC for this actor's enrollment recovery; do not transfer
   the owner's launcher secret or that retained resume token.

3. James retrieves the private connection file over SSH without printing it:

   ```sh
   (
     set -eu
     umask 077
     private_dir=$(mktemp -d /tmp/clankie-rivals-import.XXXXXX)
     scp volpe@supedupsilly:C:/Users/volpe/.clankie-rivals-peer/rivals-connect.json \
       "$private_dir/rivals.json"
     chmod 600 "$private_dir/rivals.json"
     clankie swarm connect "$private_dir/rivals.json"
   )
   ```

   This requires the service to run the implementation in this change. The
   private file's shape is:

   ```json
   {
     "id": "rivals",
     "conversationId": "global-default",
     "ssh": "pc",
     "endpoint": "\\\\.\\pipe\\swarm-mcp-9f4b9b4fcb7f974334faad33",
     "capability": "<Clankie-only session capability; never print>"
   }
   ```

4. After that explicit enrollment, the lead and James can prove criterion 4 with
   a message to the existing PC lead and an acknowledged reply. Every Swarm call
   must carry `connection: "rivals"`; omission selects the embedded coordinator.
   Keep original command IDs on uncertain retries. No workers are re-enrolled,
   and no coordinator or Herdr server is restarted.

The prepared script has been syntax-checked only; it was not run against the
PC. The actual scope and authentication remain the PC lead's enrollment step.

## Checks

- `pnpm check` passed: formatting, lint, dead-code, documentation, infrastructure,
  all 27 typecheck tasks, 339 Vitest files (2,828 passed; one skipped), 123 Rust
  tests, and the Vox IPC smoke test.
- Focused relay, fleet, import API and Swarm integration checks: 37 passed;
  import rollback/capability-isolation checks: three passed.
- The integration suite runs both local and SSH-resolved external connections,
  covering pinned identity, broker storage, restart, inbox delivery, disconnect
  and reconnect. The relay tests cover byte-preserving splicing, stdin closure,
  link retry, permissions, malformed readiness and failed local forwarding.
- `pnpm docs:check` passed after the documentation additions. The prepared
  enrollment script passed `node --check`; enrollment itself was not executed.
