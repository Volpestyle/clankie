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

## ACK fixture correction (2026-10-09)

James reported the main `052bb7661` broad-run failure in
`apps/tui/test/worker-link.test.ts`: the success case saw only one poll. The
recorded log is `.local/vuh-1885/broad-original.log` in the VUH-1885 worktree.
The fixture returned `acknowledged: true` without an `eventId`; the exact-ACK
bridge correctly stopped. This was a contract mismatch, not evidence that
production should keep polling after an incomplete ACK.

The fixture now returns the exact event ID. The subprocess cases separately
check exact, lost, missing-ID and wrong-ID ACKs: only the exact ACK permits
another poll. Assertions wait on the observed HTTP request or bridge stop
signal with a bounded five-second integration deadline, without fixed sleeps.
The four focused subprocess cases passed on current main.

## Existing consumer coverage correction (2026-10-09)

James reported seven stale contract expectations and two recovery fixture
startup deadlines in Moss's no-bail broad run (`broad-trace.log`/`.json` in the
VUH-1885 worktree). The tenth failure was the already corrected linked-channel
ACK fixture. The captain native-chat assertions now require the exact fourth
`conversationId` option. The five mailbox cases now require the actual polled
event IDs in delivered receipts, including distinct IDs for two successive
turns. Head mailbox re-poll acknowledgment remains intentional; worker
mailboxes separately require explicit ACK. No production behavior was weakened.

The complete three reported files pass with `--bail 0`: 32 tests (including all
13 inbound recovery cases), with raw inspected logs and JSON retained as
`.local/claude-proof/vuh-1870-no-bail.log` and `.json`. Recovery startup was left
unchanged. Those failures occurred before the fixture's IPC `ready` deadline;
ACK/receipt handlers had not run. Its ready path constructs the inbound report
store and listener, not the outbound SeatOutbox or channel ACK. The shared
DeliveryFence is accessed only when requests arrive after readiness. The
exact scheduling/import step that exceeded ten seconds is unproven and can be
routed as separate fixture-startup diagnostics; no timeout was enlarged to hide it.

The original landing gate was my hand-selected new transport/reconciliation,
mailbox/auth and protocol checks, not a complete existing native-delivery
consumer run. I omitted the direct captain native-chat and SeatOutbox files,
and initially the subprocess worker-link fixture. That was a selection gap,
not a claim that the full suite passed. The new focused manual
`pnpm test:seat-delivery` gate explicitly includes all those consumers, inbound
recovery and the real Claude reconciliation cases, without bail. The relevant
integration guidance now names it; full suites and evals were not added to CI.

The new focused consumer gate passed through `clankie heavy`: five full files,
86 tests, no bail. Raw output is retained in
`.local/claude-proof/vuh-1870-consumer-gate.log`. The heavy service typecheck,
scoped formatting/lint, local doc links and diff checks passed. The recovery
fixture was not changed; both previously timed-out cases passed in both runs.
