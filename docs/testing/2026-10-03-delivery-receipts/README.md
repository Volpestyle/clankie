# Shared delivery receipts (VUH-1521)

Implements accepted ADR 0211 with the retired Swarm path omitted. This is
implementation and deterministic protocol evidence; no live model or evaluation
trial was run for this change.

`deliveryStage` supplements each mechanism's existing outcome. Bridge receipt is
`delivered`; native queued/started/steered acceptance is `consumed`; correlated
replies, silence and absorbed turns are `responded`. A native queue receipt does
not prove the model saw a message. Conversation acceptance is `stored`, and
turn stream events carry the receipt separately from local run completion.

The tests cover unresolved receipts across service/launcher replacement,
explicit retry denial, original-session full-message reconciliation, old or
wrong-session receipt rejection, no fallback after uncertainty, exact bridge
acknowledgment authentication, and native context preflight without a model
turn. Discord additionally retains terminal delivery IDs and rejects a changed
fingerprint or lane rather than rerunning a turn. Unknown failure remains
uncertain; an explicit refusal or interruption has its own stop stage.

Persistence lives beside existing service state: `delivery-receipts/` for
mailboxes, watch-store companion receipt files for native messages and hires,
and `discord-turn-receipts.json` for Discord. OpenCode uses an exclusive
binding-scoped file under `opencode-seat-receipts/` as well as per-launch audit
journals. These are receipts, not dispatch queues. No timer or startup routine
replays an uncertain turn. The service ledgers assume the existing single
service writer; OpenCode's exclusive claim also fences concurrent launchers.
Discord terminal IDs are retained indefinitely to preserve deduplication.

Conservative limits are intentional: missing/corrupt evidence or an unavailable
original native transcript keeps delivery blocked. Late native reconciliation
requires a new complete operator message beyond the pre-send transcript in the
original session (a retained new hire additionally matches its generated pane
name). OpenCode requires the original event ID and full synthetic event in the
original session. Pending per-launch queues are inspection evidence and do not
become automatic restart replays. No exactly-once task completion is claimed.

For clients, `deliveryStage` is optional for older peers. Existing outcome,
`seatDelivery.state`, and queue detail remain authoritative mechanism context.
A `turn` event with `phase: completed` may still have `deliveryStage: uncertain`
or `delivered`; clients must not promote that receipt to successful work.

## Remaining issue scope

The inbound `message_clankie` boolean API now reports `stored` on actual durable
conversation acceptance and explicit refusal stages. Lost transport/5xx receipts
are `uncertain`, with further calls refused in the same bridge. This path has no
cross-restart exact delivery ID or durable retry fence yet. Completing it needs
an idempotent inbound message receipt tied to actual persisted conversation
acceptance. Restarting the bridge does not reconcile a lost receipt.

The private app has not been edited or verified in this public worktree. It must
visibly render the accepted/failure/spawn and turn-event `deliveryStage` fields,
retain queue detail, and distinguish local completion from receipt progress.
VUH-1521 remains in progress until that display and the durable inbound receipt
contract are complete; this public harvest is partial issue scope.
