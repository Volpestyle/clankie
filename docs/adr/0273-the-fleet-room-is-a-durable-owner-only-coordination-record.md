# ADR 0273: The fleet room is a durable, owner-only coordination record

Status: Accepted (VUH-2184, 2026-10-16). The app view is clankie-app ADR 0094 and
VUH-2185; a Discord mirror (VUH-2186) is a separate, later decision.

## Context

The owner wants to watch the fleet coordinate the way a team channel reads:
a lead's brief, a worker's report, a peer's note, an Auto round, a question
waiting on them. The host already keeps pieces of this, but never in one place
or in one order:

- `leadVisits` and `edges` on the fleet snapshot are memory-only windows
  (64 events, 5 minutes; ADR 0163).
- A lead's brief to a worker keeps no durable text. Only its delivery fence
  and a bounded tool summary in the lead's own journal survive.
- Worker reports, peer receipts, lead-to-lead attribution, Auto rounds and
  owner questions each live in their own store or conversation, and some can't
  be read from a device at all.

Merging those stores at read time can't recover the briefs. It would also tie
the feed's order to many unrelated file formats.

## Decision

The host writes one append-only journal, `<state>/captain/fleet-room/entries.jsonl`,
at the moments coordination already happens:

| Kind                              | Written when                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| `lead_message`                    | A lead's `message_seat` reaches or may have reached a worker, and when a hire's brief is sent |
| `worker_report`                   | A worker's report is durably accepted into its lead's conversation                            |
| `peer_message`                    | A peer message's outcome is known (delivered, or unconfirmed)                                 |
| `lead_to_lead`                    | A lead messages another lead natively, or the receiving lead's service queues it              |
| `auto_round`                      | An Auto round is admitted to the lead that runs the projects                                  |
| `owner_question` / `owner_answer` | A question to the owner is asked, then answered or withdrawn                                  |

Each entry carries:

- the source's own stable id, namespaced by kind;
- a host sequence and the time;
- who sent it and who it was for, by name;
- its bounded text (at most 2,000 characters);
- the issue keys and commit SHAs the text itself names;
- a thread reference when one exists;
- its receipt stage when recorded (ADR 0211).

A source id lands once, so retried reports or replayed deliveries never repeat
a line. An unconfirmed delivery is recorded as `uncertain` and never as read.

- **Answers stay private.** An owner's answer text is not copied. The room says
  only that the question was answered or withdrawn.
- **Credentials are scrubbed.** Text goes through `redactSensitiveText`, as
  imported transcripts do.
- **Retention.** Readers see the newest 2,000 entries, none older than 14 days.
  The file itself is compacted once it reaches 2,500 lines, or at most hourly
  once entries have aged out. A source id outside that window is no longer
  remembered, so in principle it could land again. The sequence is kept in
  `since.json`, so it never restarts, even after every entry has aged out.
- **Ids.** Each entry uses its source's own id where one exists: a delivery,
  report, question or round id, or a hire's seat and occupant. A lead message
  whose transport returns no message id gets a fresh id, so each such send is
  its own line.
- **No reconstruction.** History from before a host started recording is not
  rebuilt. `recordingSince` tells a reader where the room begins.
- **Recording never blocks coordination.** A journal that can't be written
  logs a warning, and the delivery or report goes ahead.

### Reading

The service op `fleet_room` returns a page, oldest first:

- `older` with an optional cursor reads the page before it;
- `newer` reads after a cursor and may wait up to 20 seconds for the first new
  entry, which is how a surface follows the room live.

**Who can read it.** The room carries coordination text, so only the owner reads
it, end to end:

- a paired device holding Take Control, or this machine's operator credential
  (`clankie fleet room`);
- never a support grant, a captain or worker bearer, or a Discord room.

**Same-user processes.** The CLI reads this machine's operator credential, so
a process running as the owner's OS user, a hired worker's shell included, can
read the room the same way it can already use the owner's other CLI operations.
The worker and MCP routes themselves refuse it. That is the existing
local-operator boundary; the room does gather more cross-fleet text in one
place than any single earlier operation.

**How devices reach it.** The relay requires Take Control and forwards the
device's own bearer (the owner route). The hosted envelope follows the same rule
as owner questions: the account owner's device only.

**Display only.** An entry grants no authority. A reply goes to the head through
the ordinary `send` path, never to a worker named in the room.

**Not mirrored.** Nothing mirrors the journal to a room, a channel or Discord.
That is VUH-2186's decision to make.

## Consequences

The room starts empty on each host and fills from deploy onward. Entry stages
are a snapshot of what was known at recording. A report later read by its lead
still shows `stored`, because the room does not rewrite past lines. The
per-conversation journals and receipts remain the source of truth for delivery,
and the room is the owner's view across them.
