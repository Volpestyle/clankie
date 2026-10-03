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

The inbound `message_clankie` path now covers both `--seat` and the installed
`--fleet` bridge. Tests exercise real JSON-RPC subprocess replacement and actual
ConversationStore persistence: response loss after acceptance, service restart,
pending crashes, denied receipt reads, changed text, legacy responses, concurrent
bridges, and exact-ID settlement. Persistence tests cover a crash after the
metadata acceptance write but before event publication, deterministic accepted
and interrupted run history on restart, no automatic dispatch, late acceptance,
and corrupt records. Native-binding tests resolve the current session through
the captain and refuse stale caller assertions before acceptance.

A pending bridge record only authorizes an exact read, never a new POST. The
service stores the original payload and receipt atomically in conversation
metadata before dispatch. No-ID legacy POSTs are rejected before acceptance.
The fixed startup fixture and rebased native OpenCode integration have separate
focused evidence; a passing frozen checkpoint gate is not a whole-issue claim.

The private app has not been edited or verified in this public worktree. It must
visibly render the accepted/failure/spawn and turn-event `deliveryStage` fields,
retain queue detail, and distinguish local completion from receipt progress.
VUH-1521 remains in progress until that display and the parent trust/durability
review are complete; this public harvest is partial issue scope.

The continuation also covers both restricted listener boundaries:
`fleetLinkFetch` admits only exact receipt reads and event acknowledgments, and
`LocalFleetLink.fetch` preserves bearerless pane proof, revalidation and
revocation for those routes. Raw installed-channel tests assert exact ACK after
notification output and no further poll after a lost acknowledgment. Raw
inbound subprocess fixtures pass through the real fleet route filter.
