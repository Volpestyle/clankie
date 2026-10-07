# ADR 0245: One owner ask across surfaces

Status: accepted for the core of [VUH-1809](https://linear.app/vuhlp/issue/VUH-1809)
(2026-10-07). App mailbox presentation and informational updates are a later lane.

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

## Gates and scope

Use the effective global/project `autonomy.fleet` leaves from
[ADR 0230](0230-fleet-responsibility-is-owner-settings.md). Reuse existing commit,
push and release settings. A delegated gate produces no owner ask; missing gate
categories fail closed until [VUH-1782](https://linear.app/vuhlp/issue/VUH-1782)
lands them. Owner-only actions are not delegated by these policy values.
This decision adds no presets, custom rules engine, credentials or infrastructure
setup. A release time rule remains owner-authored agent guidance, not an
expression evaluator.

The later app lane owns the top-left World mailbox, badges, asks versus
informational updates, source navigation, and iPhone/iPad layout checks.
Hosted clients use the existing authenticated operator contract; no owner setup
is added by this core API.
