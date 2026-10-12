# VUH-2174: coordination reaches a disconnected service lead

Clankie's replies at 19:29Z, 20:01Z and 21:13Z hit the native-only lead message
path and were refused. A disconnected local lead already executes Auto rounds
in the service lane; coordination now uses that same conversation's durable
inbound ledger and wakes it instead of requiring a native relaunch.

A native acknowledgment keeps its existing receipt. A definitely unbound local
lead returns `lead_service_queued`, `state: queued`, `deliveryStage: stored` and
a message ID. This means durable inbox acceptance, not native acknowledgment
or lead review. Sender-only `reconcile_seat_call` reads progress across restart.
Remote-only recipients still refuse without their bridge. An uncertain native
send never also dispatches through the service.

The host stamps the sender as lead provenance. The receiving turn is internal
agent context; it has no owner-origin instruction or new authority. Recovery
uses the existing inbound-report pending/attempted fence: pending messages can
wake after restart; attempted messages retain uncertainty and cannot blindly
replay. Worker messages retain their existing format.

## Real service proof

[proof.json](proof.json) records the authenticated loopback HTTP/MCP path through
the real captain, ledger and the saved `openai-codex/gpt-6.1-sol` service model.
No model/runtime boundary was mocked.

The isolated service retained the real Clankie Work conversation ID, workspace,
configured lead route and remembered native session, with no native channel.
Historical payloads were omitted. One receipt-only message was durably accepted,
woke the service lead and produced: “Acknowledged: VUH-2174 receipt-only marker
received. No work started.” The ledger progressed from stored to responded;
the transcript records the input as external context, never an operator message.
An unauthenticated MCP call returned 401.

After restarting the isolated service, authenticated MCP reconciliation from
the sender returned responded for the original message. The recipient could
not read that sender receipt. The typed turn log still contained one completed
turn: reconciliation did not resend the message or invoke another model turn.

The proof used an isolated HTTP/state namespace and the existing credential
broker for the saved model. It made one model turn, no hire, native relaunch,
owner-state change or PC write. The owned HTTP service was stopped afterward.
The receipt's response does not claim a native acknowledgment or general
completion of whatever future coordination requests ask for.

## Verification

Focused lead-channel and service-fallback integration checks passed while
iterating. The service source and all 13 test typecheck partitions passed.
Final focused checks and the exact-tree integration gate are recorded on the
issue when they finish. Deploy remains with Clankie.
