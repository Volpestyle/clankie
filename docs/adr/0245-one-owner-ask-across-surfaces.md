# ADR 0245: One owner ask across surfaces

Status: accepted for the core of [VUH-1809](https://linear.app/vuhlp/issue/VUH-1809)
(2026-10-07). App mailbox presentation is a separate lane; informational updates now have a core contract.

## Decision

Extend Clankie's existing `request_user_input` tool and conversation question
store. Do not introduce a second ask tool or a separate mailbox question store.
The same immutable ask appears through native MCP, console, room and service
turns, the owner HTTP API, CLI and TUI. The future World mailbox consumes the
global list of these records.

`purpose` distinguishes a decision, approval or owner-only action; `kind`
retains the existing text/choice answer control. Decisions carry options and
Clankie's recommendation. Approvals name an action reserved by the effective
owner settings. Owner-only actions carry exact steps. New asks state what waits
on the answer and keep their host-bound source conversation. Legacy preferences
and project onboarding remain compatible; a preference answer never creates a
project or initializes its tracker.

The source host may create an ask without an owner present in that turn.
Only an authenticated operator or active `terminalControl` device can list,
answer or cancel the owner mailbox. An answer is attributed to the owner and
wakes the original source through its existing service/native delivery path.
It does not change the source room's trust, mint machine authority or grant
credentials. Sign-ins and exact owner-only steps remain owner actions.

```mermaid
sequenceDiagram
    participant W as Native worker
    participant C as Clankie source conversation
    participant Q as Durable ask store
    participant O as Owner API / CLI / TUI
    W->>C: Pending native request and question IDs
    C->>Q: Escalate observed question, or create own ask
    O->>Q: List pending asks
    O->>Q: Answer immutable request/incarnation/revision
    Q->>W: Original native answer map, at most one attempt
    Q->>C: Owner answer and native delivery outcome
    O->>Q: Reconcile the same answer
    Q-->>O: Original resolution; no second dispatch
```

## Escalation and receipts

Escalation copies the host-observed worker question and pins its original native
session, request ID (including its type) and all question IDs. Model-supplied
question text is not proof. Reading a worker question for escalation requires an
admitted machine turn; a social ask does not reveal private worker context.
Owner answers return through the existing native
question-answer channel; automated terminal typing remains forbidden by
[ADR 0207](0207-work-records-and-native-agent-delivery.md).

Persist the answer's delivery claim before crossing the native boundary. A
pending or uncertain ask is retained under its original ID. Concurrent and
repeated answers reconcile that record rather than dispatch again. A replaced
native occupant cannot receive the original answer. Native uncertainty stays
visible in the source outcome and is never transformed into a successful answer
or an automatic retry. Upstream asynchronous native answers retain their documented
first-answer arbitration limits.

General asks survive the issuing turn and service restart. Project proposals
retain their original live-owner and workspace identity fences. Pending asks
protect their source from normal retention pruning. Resolution publishes the
existing conversation events, so every portal reads the same state.

## Multiple pending asks (2026-10-07)

Each conversation holds several independent pending asks from Clankie and native
workers. Repeated exact drafts reconcile; different options, `waitingOn`, or
source workspace remain distinct. Native identity deduplication still spans all
conversations and preserves the original source and authority. The legacy
preference/project slot keeps its live-owner and workspace fences.

`input_list` lists every matching ask newest first, retaining `waitingOn` on each
card. Equal timestamps use newest insertion first within a conversation and
conversation ID order across conversations. Answer and cancel target only the
immutable request/incarnation pair. The revision remains conversation-wide:
a changed sibling card can cause `revision_conflict`; refresh the list and use
the same request ID, never substitute another ask. Native reconciliation checks
all pending asks; source reset cancels all affected asks.

Retain all pending asks and submitted/uncertain native claims even beyond the
32-record settled-history window. Bound each conversation to 256 total records
and 512,000 serialized bytes, refusing new asks at capacity instead of evicting
protected records. Each ask keeps its own claim, original source continuation
authority, idempotent answer, and uncertain-receipt rules across restart. This
extends the existing app contract without changing its wire shape or adding a
second mailbox store.

## Deliberate owner updates and issue navigation (2026-10-07)

Clankie chooses what news is worth mailing through `mail_owner_update`, available
alongside `request_user_input` on his source-bound native, console, room and
service turns. No event, worker result or commit automatically publishes mail.
An update is informational: no answer, gate, continuation or `waitingOn`.
Reading or dismissing it never starts a conversation run or resolves an ask.

The shared `OwnerUpdate` contract keeps the app branch's `MailUpdate` fields:
`id`, `title`, `body`, `conversationId`, and `at`. Core requires a nonblank title
(up to 200 characters) and body (up to 2000). It adds host-bound
`source: {conversationId, seatId?}`, optional `links: [{label, url}]` and
`media: [{url, mimeType, alt?}]` (up to eight each), and state
`unread | read | dismissed` with `readAt`/`dismissedAt` timestamps.
URLs are HTTP or HTTPS navigation references; mail does not fetch local files,
publish artifacts, or confer access to linked media.

Both asks and updates accept optional `issue: {tracker, key, url}`. This is a
navigation reference, not tracker admission or authority. Different issue
references keep otherwise identical pending asks distinct. The host pins the
source conversation; a supplied `seatId` is a worker navigation hint, not proof
of a worker's identity or an authorization grant.

Updates persist atomically in the existing conversation root's
`owner-updates.json`, separate from answer/claim records because they have no
execution receipt. The publication identity is host-scoped by source and tool
call, with source-run prefixes where the harness supplies them. Repeating that
identity with the same immutable draft reconciles the original mail even after
restart while retained; changing its draft refuses. Older dismissed records
can be pruned, ending their publication deduplication window. An uncertain commit is never automatically
retried under a new identity. Keep every unread/read update; retain the latest
32 dismissed records per conversation. Like asks, each conversation is bounded
to 256 total records and 512,000 serialized bytes. Refuse capacity instead of
evicting active mail; reserve room for read/dismiss timestamps. Lists return up
to 1000 records newest first across sources.

Owner API operations are `owner_update_list` (optional `conversationId` and
`state: unread | read | dismissed | all`; omission lists nondismissed mail),
`owner_update_read`, and `owner_update_dismiss` (exact update `id`). Read and
dismiss are idempotent; reading dismissed mail never reopens it. These require
the same current operator or `terminalControl` device authority as asks,
including hosted transport. A captain bearer alone cannot list or mutate mail.
Publishing is a deliberate source-bound tool, not an owner dispatch operation.

The app branch `vuh-1809-mailbox` was read without edits. Its optional
`OwnerUpdateService.list()` expects an array and `.dismiss(id)` returns void:
an adapter unwraps `client.ownerUpdateList().updates` and awaits
`client.ownerUpdateDismiss(id)`. Core is a structural superset of that app's
fields; the app needs to bind this slot and can add explicit read-state controls,
links/media and issue navigation. This ADR defines the core wire contract.

## Gates and scope

Use the effective global/project `autonomy.fleet` leaves from
[ADR 0230](0230-fleet-responsibility-is-owner-settings.md). Reuse existing commit,
push and release settings. A delegated gate produces no owner ask; missing gate
categories fail closed until [VUH-1782](https://linear.app/vuhlp/issue/VUH-1782)
lands them. Owner-only actions are not delegated by these policy values.
This decision adds no presets, custom rules engine, credentials or infrastructure
setup. A release time rule remains owner-authored agent guidance, not an
expression evaluator.

The app lane owns the top-left World mailbox, badges, asks versus
informational update presentation, source navigation, and iPhone/iPad layout checks.
Hosted clients use the existing authenticated operator contract; no owner setup
is added by this core API.

## Native takeover and resolution attribution (VUH-1881, 2026-10-08)

Native seat attachment and polling leave unanswered questions pending in their
source conversation; takeover is not an answer or cancellation. Existing owner
and workspace checks still apply. New workspace preferences and project
confirmation remain unavailable while the native driver owns the conversation.
Existing workspace preference answers also refuse with `native_driver_active`
and stay pending, preventing a competing service continuation; owner asks with
semantic purposes retain their normal source answer delivery.

Question reads expose `resolvedBy: {kind: operator | device | service, id}`,
`resolvedAt`, and the cancellation `reason` code. The existing `input_resolved` event remains compatible with strict legacy
clients; refresh the question record to read attribution. Explicit cancellation names its authenticated caller;
automatic cancellation names the service. Submitted legacy records expose their
stored responder; older cancellations with no recorded actor leave it unknown.
Render `status: cancelled` as cancelled, never as an answer or selected option.
These records do not turn driver takeover into owner approval.

The app presentation change follows separately. Historical cancellations stay
cancelled; this change does not recreate their pending requests or fabricate an
answer. Native attachment does not remove the workspace or original issuer
fences. Project creation still refuses when the native driver has taken over.

## Built-in tracker asks and gates (VUH-1919, 2026-10-09)

The proposed [ADR 0226 amendment](0226-one-tracker-tool-surface.md#amendment-evidence-bundles-owner-asks-and-run-gates-2026-10-09-vuh-1919)
reuses these records for item decisions, landed-item verification (`verify`) and
run approvals (`gate`). Items and runs link the mailbox `requestId`; they do not
store another question or answer. A gate names plan, spend, destructive action,
merge or external write and blocks its run until an authenticated owner chooses
Approve. Decline, cancellation and free text leave it blocked. Tracker-raised
asks carry a host publication identity so replay reconciles the retained record;
the loop reads settled receipts on restart. Lead run controls retain the lead's
attribution and never stand in for owner approval.
