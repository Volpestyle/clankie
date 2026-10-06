# VUH-1743: target-chat receipts and project destinations

This is an additive source follow-up to `2d23a90e`, `7f7b2bbd`, `d321e4dd` and
`bb1c9184`. It implements James's 2026-10-06 acceptance decisions in
[VUH-1743](https://linear.app/vuhlp/issue/VUH-1743). Live original-Claude
acceptance is still pending; no live inbox read or route change was performed.

## Behavior

- Verified project UUIDs select an explicitly configured existing ordinary lead
  chat. Unconfigured projects or removed lead chats go to `global-default` with
  their project name. Nonproject activity retains the configured default target.
  Sparse signed issue/update parents acquire context through bounded native
  connected reads. External entries and `linear deliveries` retain destinations.
- Every offered batch has a host-issued original wake ID. Native receipt
  preparation retains the exact content fingerprint and recipient binding before
  delivery. `linear_wake({ action: "received", wakeId })` derives its target chat
  from host authority and confirms only that original. A transport ACK alone
  leaves Linear notifications unread. Another chat, untaken wake or replaced
  recipient cannot confirm it.
- Only events included in that received batch become eligible for read marking.
  Unique signed comment anchors tolerate delayed notification creation (the
  original KH2 notification lagged its hook by approximately eighteen seconds).
  Unknown and ambiguous matches remain unread. Account identity is rechecked
  before every read mutation. Claims persist before dispatch; uncertain writes
  settle by read-only inbox observation and are never repeated, including after
  restart. Bounded retries use the shared background request budget.
- Settings are exposed through the agent tool, authenticated `/v1/linear/routes`,
  `linear routes show|set --json-stdin` and `/linear` → **Project lead chats**.
  `/v1/linear/deliveries` and `linear deliveries` inspect offered batches and
  target consumption receipts; an offer is not proof of delivery.

## Owned verification

[Integration source](../../../apps/clankie/test/linear-wake-receipts.integration.test.ts)
uses real disk settings, the production conversation runner/store/outbox,
authenticated HTTP signed ingress and seat wire, the production `linear_wake`
tool over the actual SDK transport, and a stateful owned provider MCP server.
The provider owns temporary notifications and effect records; no live account,
model, harness substitute, simulator or eval is used.

The focused run passed **71 checks in nine files** on the current-main base
`71222bca`. It covers configured lead and named default routes, sparse project
update parents, API/CLI settings, target consumption after transport ACK,
wrong-chat/changed-recipient/untaken refusals, delayed inbox creation, uncertain
mutation holds, ambiguous signed evidence, and shutdown/reload followed by a
fresh comment without replay. Existing native delivery and attribution checks
remain green. The integration fixture explicitly supplies its owner identity,
preserving main's empty new-install owner defaults.

The four affected packages passed typechecking. Changed TypeScript passed lint
with warnings denied. Documentation checks passed all 461 Markdown files and
the generated public surface (10 pages, 184 API operations); formatting passed.

Raw owned receipts stay in the worktree's ignored
`.local/evidence/vuh-1743-routing-read/`: `focused-main.txt`, `types-main.txt`,
`lint-main.txt`, `docs-main.txt` and the formatting receipts. Prior red runs
retain the receipt-header assertion/fixture corrections; they are not reported
as source regressions. Every install and check used the fleet heavy wrapper
and `clankie heavy`; no simulator or eval was run.

## Original bridge recovery remains operational follow-up

The preserved original is Claude PID `99898`, bridge PID `51139`, conversation
`global-default`, pane `w3Z:p2N`, session
`5bcd52ff-8d50-4139-962a-46b323c7a990`. Its provenance points to loaded `e1f45750`
source: a fatal notification/ACK rejection silently exits its one receiver pump
while tools remain usable. The exact original stopping error is unproved.
See the [pump source/evidence](../2026-10-06-seat-pump/README.md).

Installing new source does not replace that already-imported module or restart
the ended async invocation. A normal tool-channel registration has not been
proved to restore its pump. The pump fix self-heals ACK-only failures in a newly
loaded bridge; notification failure retains its no-replay fence.

A supervised reconnect of the existing session's MCP connection must be selected
by the lead/integrator after the canonical deployment gate. Preserve the same
Claude session, pane, account home, `global-default`, loaded-process provenance
and original pending/delivered receipts. Do not clear, repoint or replay an
uncertain original. No automated Claude reconnect interface within those fences
has been verified, so this branch adds no speculative restart mechanism.

After Pell supplies the healthy installed revision and canonical update receipt,
verify the original receiver's new loaded source and polling without a replacement
conversation. Then the lead asks James for one fresh comment. Correlate its signed
webhook receipt, chosen external journal event, original native ID/fingerprint,
`w3Z:p2N` channel transcript and target-chat consumption receipt, followed by the
notification's read-only `readAt` observation. Until that chain exists, keep
original owner delivery and VUH-1743 closure pending.

The native worker tools refused this session's membership during this follow-up:
connected discovery returned `local_process_membership_required` (403), while
`message_clankie` and `message_peer` explicitly reported that nothing was sent.
No alternate sender, account connector or terminal typing was used.
