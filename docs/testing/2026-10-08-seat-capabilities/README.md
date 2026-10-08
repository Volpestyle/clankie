# Operator seat capability negotiation (VUH-1817)

The October 6 operator MCP process rejected owner `turn` events and the new
`ownerOrigin` field after the service update. Its strict decoder logged poll
ZodError; the service retained unconfirmed receipts after its two-second grace.
The trace and exact original IDs are attached to VUH-1817. James subsequently
settled those originals as abandoned-unknown and answered them; none is replayed.

The authenticated seat poll now carries loaded capabilities (event kinds,
owner-origin support, optional captured source hash). No declaration is the
legacy wire contract. The service projects an owner turn into `message` with
content attribution when the receiver cannot decode its newer shape. Projection
keeps the original ID and content fingerprint for exact receipt reconciliation;
no new send or reply target is created. All wire fields are selected explicitly.
Unsupported events are refused before dispatch. Room escalation reply routing
and host-verified owner admission remain the same.

A stale receiver produces one durable service notice in the shared conversation:
`Clankie's seat needs a reconnect: /mcp`. A taken owner turn that loses receipt
confirmation produces a notice naming its original ID, while its uncertainty
fence remains intact. Notices do not queue a model turn. `clankie doctor` and
`clankie status` read the operator `seat_bridges` dispatch observation, including
loaded capabilities, last poll, and hash when declared. They do not acknowledge
or settle receipts. A fresh capable bridge reports current after reconnect.
Capabilities survive the service reconnect grace through the presence journal.

## Verification

[seat-capabilities.integration.test.ts](../../../apps/clankie/test/seat-capabilities.integration.test.ts)
uses the production captain, HTTP owner routes, seat outbox, conversation journal
and receipt stores. Real stdio MCP bridge subprocesses receive owner turns; the
legacy mode removes the new handshake and decodes the exact old strict page
shape before any channel notification. Both paths prove a delivered original,
one notification, honest owner attribution, and no decoder error. Legacy mode
also reads the notice through owner replay and checks doctor/status diagnostics.
A lost-ACK HTTP case verifies the owner notice and byte-identical retained fence
after read-only diagnostics. Existing owner-turn integration covers one synced
answer, room escalation, revocation, spoofed surfaces and concurrent revisions.

The SDK channel peer proves bridge transport, not a live Claude model's reading.
No paid eval, live service restart, live receipt settlement or replay is performed.
Deploy this service fix; reconnect the operator MCP bridge with `/mcp` to get the
modern shape. Then verify a fresh owner app send and one normal synced answer
on iPhone and iPad before closing the original live acceptance gap.

Commands, all through the heavy queue:

```sh
clankie heavy -- pnpm typecheck
clankie heavy -- pnpm exec vitest run apps/clankie/test/seat-capabilities.integration.test.ts apps/clankie/test/owner-app-seat-turn.integration.test.ts
clankie heavy -- pnpm check:landing
```
