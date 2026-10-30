# ADR 0304: The owner hands Clankie's lead to the connected apps

Status: Accepted by James, 2026-10-30. Builds on
[ADR 0301](0301-claude-reaches-the-fleet-through-a-narrow-connector.md) and
[ADR 0303](0303-connected-apps-answer-agents-prompts.md).

## Context

James wants one lead for his agents. Today Clankie's own model turns answer
his hired workers' messages, reports and questions, his wakes and his watches,
while Claude in the Claude apps (through the connector) also lists, reads and
messages the same agents. Two leads answering the same worker step on each
other. James asked to pause the old lead and let the connected apps lead.

## Decision

Who leads Clankie's lead threads is one owner setting: `clankie` (the
default) or `apps`.

- **Set at the Mac.** `clankie connector lead [clankie|apps]` reads or sets it
  with the owner's credential. It is stored in the service's state directory
  (`lead.json`, mode 0600). A missing file means Clankie leads; an unreadable
  one means the apps lead, so a damaged setting never restarts his turns.
  Handing the lead back to Clankie restarts his own turns, so only the owner
  does it; no app, device or captain bearer can.
- **Held, not lost.** While the apps lead, a turn Clankie would have taken
  himself in a global or workspace lead thread is held instead of running his
  model: a wake, a watch, a worker's message or native question that his lead
  would have answered. Held turns stay in `lead-held.json`, the newest 500.
  Worker reports to those threads stay unread instead of waking him. The
  owner's own messages still reach Clankie, and rooms, channels and persona
  threads are never handed over.
- **Read by the apps.** The connector gains `read_inbox` (held turns after a
  cursor, plus the lead threads with unread reports), `read_reports` and
  `acknowledge_reports`. The relay lets a connector read the lead status and
  inbox, never set it. It allows reports only while the apps lead, and only
  for a global or workspace lead thread (`403 connector_not_leading`
  otherwise). An app answers a worker with `message_agent`, or the prompt open
  in its pane with `answer_prompt`.
- **The owner's questions stay the owner's.** A worker question a gate
  reserves for the owner still goes to the owner's ask store, and
  `answer_prompt` refuses that pane.

## Consequences

- With the lead on `apps` and no app reading, nothing answers the workers but
  the owner. The inbox keeps what was held so an app can catch up.
- Held items come from workers and timers. The connector labels them as
  information, never the owner's instructions.
- A worker question delivered through a synchronous hook may not show as an
  open prompt in its pane. The app sees it held in the inbox, but can answer it
  only once it shows.
