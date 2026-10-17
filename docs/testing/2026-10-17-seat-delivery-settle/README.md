# VUH-2358: settle an unresolved original that blocks a seat

On 2026-10-17, a peer handoff whose acknowledgment never came made every later
lead `message_seat` to Lark refuse. Then the same happened to Moss.
`reconcile_seat_call` was read-only, and only the owner could settle.

## Changes

`apps/clankie/test/seat-delivery-settle.integration.test.ts` runs the real
durable mailbox, native-control fence, watch store and lane MCP endpoint. The
recipient's transcript is a recorded observation. It covers:

1. **The issue's repro, then a lead settle.** The original is taken but never
   acknowledged and never in the session, so a different message is refused.
   `settleSeatDelivery` is refused for another conversation, then records
   `settled: "not_delivered"`, and the next message is delivered. Only two
   messages are ever sent.
2. **A lead settle where the original did arrive.** If it is in the session, it
   is recorded as delivered instead.
3. **The bounded settle.** The original still blocks inside the bound, and still
   blocks while the recipient is working. Once the recipient is idle, past the
   bound and still without the original in its session, the next message is
   delivered.
4. **Proven arrival.** It still reconciles as before (VUH-2034).
5. **Over the lead's MCP tools.** `message_seat` is refused. A plain
   `reconcile_seat_call` changes nothing. A malformed settle is refused.
   `reconcile_seat_call({deliveryId, settle: "not_delivered"})` settles, and the
   next `message_seat` is delivered.

## Results

All checks ran through `clankie heavy --`.

- [Before the fix](before-fix.txt), cases 1, 2 and 3 failed.
- [After the fix](focused-tests.txt), 58 tests passed across the new file,
  `claude-delivery-reconciliation`, `native-delivery-fence` and `lane-mcp`.
- [Mutations](mutations.txt): with the bounded settle removed, case 3 fails; with
  its idle-recipient guard removed, it fails too.
