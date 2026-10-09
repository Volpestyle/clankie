# Claude worker delivery receipts: VUH-1870

## Cause and decision

Read-only receipt inspection confirmed a native control fence remained pending
while its worker mailbox had no unresolved event. The fence retained an internal
UUID rather than the exact channel event ID, so neither the operator receipt
reader nor the head-only delivery list could find the blocking original.

Lead implementation decision under James's assignment: correlate by exact native
channel event ID, recipient binding, content fingerprint and occupant. A channel
ACK proves transport delivery; it does not prove model consumption. Preserve the
no-replay boundary. [ADR 0207](../adr/0207-work-records-and-native-agent-delivery.md)
and [CLI recovery](../cli.md) describe the contract.

## Checks

- Focused Vitest covering worker launch/control, persisted native fences,
  operator MCP and fleet event API: **6 files, 95 tests passed** before the final
  additional MCP and legacy reconciliation cases.
- Real durable mailbox/native fence integration covers two consecutive ACKs,
  restart/late ACK, explicit polling without ACK, wrong IDs/bindings, replacement
  occupants, scoped operator recovery, owner-only abandonment, retained unknown
  evidence, and new intent without replay.
- Focused MCP receipt integration plus the new reconciliation file:
  **2 files, 19 tests passed**, including reconciliation by the original MCP UUID
  and legacy native fences retained for settlement without guessing their ACK.
- Worker bridge subprocess, fleet event API and mailbox checks:
  **3 files, 27 tests passed** before changing worker polling to require explicit
  ACKs; the changed mailbox tests passed separately (**2 files, 21 tests**, with
  the operator MCP file).
- `clankie heavy -- pnpm --filter @clankie/clankie typecheck`: **passed**.
- Scoped formatting/lint and `git diff --check`: **passed**.

## Mac live transport proof

Claude Code **2.1.295** ran interactively in the throwaway Mac Herdr pane created
for this assignment. An isolated loopback service used the checkout's actual
worker channel bridge and durable `SeatOutbox`, temporary bearer and state;
no installed service was replaced. The bridge emitted and explicitly ACKed two
consecutive events:

- `seat-6e708f1f-9543-478e-aa45-68c8e5b8296e`
- `seat-e65391da-570e-47a7-b361-1ce44118d0b4`

Both returned `outcome: delivered`, `deliveryStage: delivered`, with their own
exact IDs. This first run established transport receipt only: catalog discovery
was delayed and the native channel registered afterward. It is not model
consumption evidence. Local raw evidence is ignored under `.local/claude-proof/`.

No PC input, existing-pane steering, dotfiles changes or deployment occurred.
PC acceptance remains untested live under the explicit Mac-only proof boundary.

A second run waited until native channel registration before dispatch. At
01:54:51–52 UTC on 2026-10-09, Claude received and responded to:

- `seat-83a1b4e0-b8c8-4fe8-943e-421e60184d00`: `VUH1870_LIVE_FIRST`
- `seat-cfa5b8cc-09bc-4b57-aa2f-10308c59dae3`: `VUH1870_LIVE_SECOND`

The native TUI displayed both channel events and both exact replies; the durable
mailbox recorded the corresponding ACKs and `delivered` results. The isolated
fixture intentionally exposed no connected tools; its catalog readiness failed
while the native channel registered and handled the events. Connected-tool
admission is covered by the real HTTP/subprocess tests, not this live fixture.
The test Claude process was stopped after proof, releasing its heavy permit.

Final additional checks: the seven real mailbox/native/MCP reconciliation cases
passed; protocol transport-stage checks passed (three tests); peer route/message
and service fallback checks passed (three files, 60 tests).
