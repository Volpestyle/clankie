# VUH-1898: sender delivery receipts

The original `3285bb61-2084-4696-bcd8-2358428af2f2` receipt was retained under
`global-default` with the original unadopted pane and binding. The 404 body was
`not_found`, emitted by the fleet-link allowlist before the status handler. Both
local and remote links allowed receipt reconciliation but omitted the read-only
`/messages/<id>/status` route. The actual status handler distinguishes an unknown
receipt with `unknown_message_receipt`.

The fix admits that status route without changing sender/process authorization.
Accepted reports retain stable stored/taken/acknowledged event IDs, the first
consumption timestamp, the optional lead receipt, and transport acknowledgments
in the original durable conversation. Pending events wake the existing native
channel poll and replay after reconnect until transport acknowledgment. That
acknowledgment cannot mark the lead's report read. Lead review supplies optional
summary and links through the tool, API, or `agents reports ack --receipt`.

Old bridge status decoders retain the existing three-field response. Existing
receipts remain readable without new fields; historical inboxes do not emit a
backlog until explicitly offered again. The new durable receipt fields require
the updated service reader: an older service's strict schema does not accept
them. A service downgrade needs state migration/restore, not just old binaries.

## Checks

- 32 tests passed across receipt recovery, sender receipts, and local/remote
  fleet-link authorization contracts.
- Protocol, service, and TUI typechecks passed.
- Scoped lint passed.
- 5 CLI-to-HTTP report tests passed, including receipt summary/link forwarding;
  TUI typecheck passed again after the forwarding fix.

## Native sender proof

Claude Code 2.1.295 ran interactively in an owned isolated Herdr pane. A scratch
service used the changed production captain, fleet link, HTTP routes, durable
conversation store, native process helper, and channel bridge. No worker was
hired or adopted. The native Herdr session hook identified the real Claude
session, and fleet admission used kernel socket/process observations.

The sender called `message_clankie` once, then `message_clankie_status` once:

- 04:49:21Z: stored receipt `83c4fbae-b5f7-49b8-9e2f-b26fc763c539`.
- 04:49:25Z: status returned HTTP 200 with that exact ID.
- Stored, taken, and acknowledged events reached Claude's native channel.
- The acknowledgment included “Confirmed the native receipt flow.” and the
  [VUH-1898 issue](https://linear.app/vuhlp/issue/VUH-1898).
- The final transport ACK initially hit a native admission 503. Reconnecting
  this same Claude session delivered the same retained event ID; ACK then
  returned 200. The original message was never resent.

The lead read and acknowledgment used the production operator service in the
scratch host, without a model evaluation. This host did not configure a model
runner; its attempted model dispatch failed, so the intervening status honestly
reported `uncertain`, even though the accepted report remained stored. This is
a native sender/API/store/channel proof, not a full lead model-turn proof.

The scratch policy disabled peer messaging; its native catalog mod warned about
missing peer tools. The sender bridge's expected catalog was set to the actual
four enabled tools. This did not change process admission or receipt authority.
The scratch session and service were stopped after capture. No existing user
or operator pane was used, and nothing was deployed.

[HTTP receipt/event capture](receipt-events.json) and
[native pane transcript](native-pane.txt) contain only this synthetic proof.
Full local debug logs are under `.local/vuh-1898/live-3/`.
