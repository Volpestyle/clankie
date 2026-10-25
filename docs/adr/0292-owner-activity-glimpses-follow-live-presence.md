# ADR 0292: Owner activity glimpses follow live presence

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
free-text credential redaction apply before publication. The latest active
tool or committed message supplies the text; there is no invented task caption.
A completed tool/turn or waiting event clears it. Call text additionally requires
the same conversation's active voice lease, and disappears after hang-up or
lease expiry. Unavailable state provides no glimpse.

Presence reads this projection in memory during its existing update. It adds
no poller, model call, transcript scan, filesystem read or timer. A stable ID
and unchanged cursor prevent remounts on quiet updates. `clankie status` opts in
with the operator credential and displays the same text; older strict hosts
retain their ordinary presence response through a bounded compatibility retry.
The private app owns layout and interaction; API publication alone does not
prove a bubble was displayed.
