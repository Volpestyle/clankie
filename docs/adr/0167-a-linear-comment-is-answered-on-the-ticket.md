# ADR 0167: A Linear comment is answered on the ticket

Status: accepted (James, 2026-09-07, operator console). Amends the wake's job
in [ADR 0165](0165-a-linear-comment-wakes-the-operator-thread.md); ingest,
signature, author filter, and the doorway are unchanged.

## Context

ADR 0165 wakes the operator thread when James comments in Linear, quotes the
comment as untrusted text, and tells him to look without dispatching a pane.
That made the tracker a place work is recorded, not a place it is answered.
James writes direction into issue comments and expects the ticket to hold the
reply — after Clankie has done whatever the comment needs, including handing
the work to a seat.

The ingest is already correct: only his comments wake, the body stays quoted
rather than treated as a prompt, and a comment from anyone else (including
Clankie) never re-wakes the thread. What was missing is the reply surface.

## Decision

**A verified comment is something to do, and the ticket is where the reply
goes.** The host-authored wake still lands on the operator thread. It still
quotes the comment as untrusted text. It now tells him to do what the comment
needs — look, hire, work it himself — then comment on that Linear issue as
soon as the action is in motion.

The wake is the approval to post that one reply. He does not wait for this
thread, and nothing scripts the words. A suggested pane remains a hint, not a
route: he still chooses whether to hire, which seat, or to do the work
himself. ADR 0161's mailbox is still how a seat reads mail; this is not that
path.

His own Linear comment cannot wake him. The author filter already drops
everyone but James, so the reply cannot loop.

## Alternatives considered

**Keep looking without acting.** Rejected: James writes the comment as
direction, and the ticket is where he will look for the answer.

**Route the comment into the pane that looks like the ticket.** Still
rejected. The ticket-to-pane match is a heuristic, and a wrong route spends a
worker's context on someone else's ticket. He decides; the suggestion is
still only a name.

**Treat the comment as an operator message.** Still rejected, on the same
grounds as ADR 0165: it would appear as though he typed it here.

**Post a canned acknowledgement before acting.** Rejected: that scripts
words and spends a Linear comment on nothing the ticket did not already know.

## Consequences

- A comment from James is answered on the issue once Clankie has started the
  work, so Linear holds both the direction and the reply.
- The operator thread still sees the wake. It is no longer the only place the
  answer lives.
- A long handoff replies when the hire (or the first real action) is in
  motion, not when the worker finishes.
- Nothing new is ingested. The doorway, secret, and author filter are the
  ones ADR 0165 already shipped.
