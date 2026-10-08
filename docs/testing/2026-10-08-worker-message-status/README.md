# Worker message delivery status (VUH-1811)

A worker can retain `message_clankie`'s delivery ID and read its current ADR 0211
stage through `message_clankie_status`, or
`clankie agents message-status DELIVERY_ID` from its native pane. The API is
`GET /v1/fleet/seats/{paneId}/messages/{id}/status`.

The service reads the durable original report and checks both its sending pane
and the current native binding. It revalidates that binding before returning.
The route also revalidates local/remote membership. A replacement seat cannot
read an old seat's receipt. Unknown receipts return 404 without sealing absence;
uncertain sends still use the existing original-message reconciliation path.

Lookup never enqueues work, reconciles admission fences, acknowledges the report
or edits the message. A lead's explicit read acknowledgment projects as
`consumed`; a later native response can advance that report to `responded` while
preserving its read state. Stages describe transport/turn progress, not whether
the requested task was completed.

## Verification

The integration cases in
[worker-bridge-health.integration.test.ts](../../../apps/clankie/test/worker-bridge-health.integration.test.ts)
start owned real stdio worker bridge subprocesses for Claude and Codex, with an
isolated HTTP service, production seat routes and durable conversation/report
stores. The controlled lead runner emits its normal delivery receipts. They
send once, read `stored`, advance through `delivered` and `consumed`, and read
`consumed` from the original bridge and CLI. The report and admission-fence bytes
are unchanged by that lookup; only one message POST occurred. After an explicit
lead acknowledgment, the real runner's response advances the same ID to
`responded`. Replacement bindings are refused. A separate bridge case retains
`expired` and checks unknown IDs, malformed IDs, another pane and revoked
membership.

These are bridge/API/store integration checks, not paid model evals or claims
about a newly deployed live worker. No live service restart was performed.
Deploy the service and refresh worker bridge catalogs to expose the new tool in
existing native sessions. Both worker manifests ship version 0.6.9 so native
plugin caches can receive the new helper and catalog.

Commands (all through the fleet heavy queue):

```sh
clankie heavy -- pnpm exec vitest run apps/clankie/test/worker-bridge-health.integration.test.ts -t 'original report|expired stop'
clankie heavy -- pnpm check:landing
```
