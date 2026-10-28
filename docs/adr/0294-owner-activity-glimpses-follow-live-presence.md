# ADR 0294: Owner activity glimpses follow live presence

Status: accepted (VUH-2819, 2026-10-25).

The Mac pet needs the actual work behind its laptop and phone poses: a short
message that can expand and open its source. Presence's existing public labels
cannot supply that, and the newest inbound arrival is not proof of current work.

The existing presence request gains `includeCurrentActivity`. Only the machine's
operator or an owner Take Control device may opt in. The relay carries the
original device identity through the owner route; support grants, visitors,
workers and Discord bearers cannot read this content. Authority is rechecked
when a long read returns. Existing fields, public activity labels and legacy
responses are unchanged.

`currentActivity` is optional and contains a stable event ID, `source`
(`chat`, `discord`, `issue`, `coding` or `call`), safe full text, and a typed
conversation, issue-key or worker destination. There are no arbitrary URL targets.
An explicit issue key in a Linear tool's structured arguments may open that
issue; otherwise its own conversation remains the destination.

The conversation store retains a bounded, volatile projection when live events
arrive. Only top-level owner global/workspace threads qualify. Mixed rooms,
channels, worker conversations, side forks, reasoning and historical transcript
folds are excluded. The existing diagnostic structured-key sanitization and
free-text credential redaction apply before publication.

VUH-2949 amends tool publication: optional `kind: "tool"` distinguishes work
from speech without changing existing sources or targets. Tool text contains
only a one-line human description (`description` or `taskTitle`) or a fixed
plain label, never a tool name or serialized arguments. Explicit Linear issue
keys retain their destination. The pet suppresses tool bubbles; chat, calls
and owner questions retain their existing text. Older hosts may omit `kind`. A pending owner question
takes priority over the volatile event projection.
Its canonical receipt supplies the full redacted prompt, a stable question/incarnation
ID and its own conversation target. Answering or cancelling it removes that
glimpse on the next existing presence read. Mixed-room and side-fork questions
remain withheld. The same pending-question selection already used by presence
is reused, without another question scan or a new cache. Otherwise the latest
active tool supplies its safe label or a committed message supplies its text.
Underlying event lifetimes are still checked while a question is visible.
A completed tool/turn or waiting event clears its event glimpse. Call text additionally requires
the same conversation's exact active voice-lease incarnation, captured when
the line is published, and disappears after hang-up, replacement or expiry.
A native source/session change invalidates its cached activity even if the
replacement remains working throughout. The fresh presence census also fences
the head occupant before a replacement transcript arrives. Neither fence depends on a presence
read observing an idle gap. Unavailable state provides no glimpse.

Presence reads this projection in memory during its existing update. It adds
no poller, model call, transcript scan, filesystem read or timer. A stable ID
and unchanged cursor prevent remounts on quiet updates. `clankie status` opts in
with the operator credential and displays the same text; older strict hosts
retain their ordinary presence response through a bounded compatibility retry.
The private app owns layout and interaction; API publication alone does not
prove a bubble was displayed.
