# 0336. A connected app wakes a lead at its own webhook

Status: accepted (James, 2026-11-01). Builds on
[ADR 0301](0301-claude-reaches-the-fleet-through-a-narrow-connector.md) and
[ADR 0304](0304-the-owner-hands-the-lead-to-connected-apps.md).

## Context

Clankie has more than one connected lead. Claude Duet reaches the fleet
through the connector, and so does Grok Bot, which runs as a Cursor agent and
can run terminal commands on the owner's Mac. Claude Duet can't restart
Clankie on the Mac; Grok Bot can. But a connected app only answers when its
own user talks to it: nothing in Clankie could hand Grok Bot a job.

On October 31 Grok Bot made a webhook routine on Cursor's side. A POST to its
address with its key in the `Authorization` header woke Grok Bot, which
answered within seconds. James asked for Claude Duet, and any connected app,
to be able to wake Grok Bot that way through Clankie. Clankie did not yet send
anything to a lead's webhook.

## Decision

A connected lead's wake webhook is a credential, and Clankie sends it one kind
of thing: a job's text.

- **Stored once, at the Mac.** `clankie connector wake set NAME` reads the
  webhook's address and its key from stdin, two lines, or from prompts with the
  key not shown; never from argv. It keeps them in the credential broker
  (Keychain on macOS) under `lead-wake-NAME`. The address must be https with a
  named host, or http on loopback for a lead on this Mac. A bare key is sent as
  `Bearer KEY`; a value that already names its scheme is sent as it is.
  `clankie connector wake` lists the names, and `wake clear NAME` forgets one.
  Nothing else ever prints the address or the key.
- **Sent by name.** The connector's `wake_lead` tool takes a lead's name and
  the job's text. The relay stamps the app's device on the request, as it does
  for a note, and the service names the sender from that device's own record.
  The owner sends one with `clankie connector wake send NAME TEXT`. The
  service POSTs `{source, kind, lead, from, text, sentAt, reply}` as JSON with
  the stored `Authorization`, follows no redirect, waits up to 15 seconds and
  reads only the status. The address, the key and the webhook's reply body
  never come back to the caller, the log or a note.
- **Answered on the board.** The lead answers the way connected leads already
  do: `post_note` on the connector, which the sender reads with `read_notes`.
  The job carries a one-line hint that says so. `sent` means the webhook took
  the job, not that the work is done.
- **Narrow.** Any app the connector serves may wake a lead, as it may already
  message an agent. The connector's per-app `serve` switch turns that off with
  everything else. There is no other target: a wake goes only to a webhook the
  owner stored.

[ADR 0343](0343-connected-hires-wake-their-lead-on-reports.md) adds content-free
worker report and settled-watch notifications on the same stored webhook.
Reports stay in the inbox for `read_reports`; their text never enters these wakes.

## Consequences

- Updating the Mac's Clankie can be a job: Claude Duet asks Grok Bot to run
  `clankie restart all` and report health, which a runner without the
  unlocked Keychain can't do.
- A lead's webhook key in the broker is as strong as the lead it wakes. A
  connected app that can wake Grok Bot can ask it for anything Grok Bot can
  do; the lead weighs a job as another app's request, never the owner's word.
- A wake whose webhook doesn't answer in time may still have arrived. The tool
  says so, and the sender checks the board before sending it again.

## Amendment: a board note addressed to a lead wakes it (#179, 2026-11-03)

On October 31 Grok posted a note "For Duet" on the board, and Duet didn't see it
until James nudged it by hand: a note waits for its reader to call `read_notes`.
James approved where any wake goes when its lead can't take it (board note
14625): the live lead pane first, then the lead's webhook, then Clankie's own
model, and nothing sits waiting.

- **Addressed by name, in a field.** `post_note` takes an optional `to`: one to
  four lead names. A name is `clankie` or a lead with a stored wake webhook.
  Names are lowercased and duplicates dropped. A name no lead goes by refuses
  the whole post (`unknown_lead`, with the names a note can use), so a typo
  posts nothing. The note's words are never read for an addressee: "For Duet"
  in the text wakes nobody. Unaddressed notes behave as before.
- **Once per note and lead, with a receipt.** The service wakes each named
  lead once, right after the note is recorded. It journals the addressees
  before the first wake goes, in `fleet-room/note-wakes.json` beside the room.
  Each settled wake leaves a receipt `{receiptId: "note:SEQ:LEAD", lead,
reached, held?, steps, at}`. The post answers with the note and its
  receipts, and every board read (`read_notes`, `clankie_read_notes`,
  Clankie's own `read_notes`, `clankie connector notes`) shows each note's
  `to` and `wakes`. If a restart cuts a wake short, it is settled as
  `uncertain` and never sent again.
- **The chain.** Only Clankie has a lead pane the service can reach: his
  bound lead seat. A connected app's chain therefore starts at its webhook.
  1. A connected lead's webhook gets kind `board_note`. The job text holds
     only the note's number, its author, and a `read_notes {"since": …}` hint.
     The note's own words stay on the board.
  2. If the webhook didn't take it (`not_set`, `refused`, `unavailable`, or
     `uncertain` because it didn't answer in time), the wake goes to Clankie's
     lead lane. It names the lead it was for and says so.
  3. Clankie's lead lane is his live lead pane when one is up (`lead_pane`).
     Otherwise it is his model (`clankie`). While the apps lead, his model
     takes no turn: the lane keeps the wake for them (`held: true`, ADR 0350).
     Watch (ADR 0308) refuses it, and the receipt says `none`.
     A note addressed to `clankie` starts at step 3.
- **Information, not instruction.** No wake carries the note's text. The
  reader takes the note from the board as another app's information to weigh,
  never as an order. An address grants nothing: a connected app could already
  wake any stored lead with `wake_lead`. What is new is that a note can also
  give Clankie's lane a turn, and that turn holds only the note's number and
  author.

## Amendment: addressed notes wake Clankie's lane only so often (#625, 2026-11-03)

Each wake into Clankie's lead lane can give his model a turn, so a connected app
could buy turns as fast as it posts. One app's addressed notes now reach his lane
at most 6 times in 10 minutes (`APP_NOTE_LANE_WAKES`), counted by the connector
device the service stamped on the post (its device id), never by the name an app
registered under: two devices sharing a name each get their own bound, and renaming
doesn't reset one. Notes addressed to `clankie` count, and so do notes whose
webhook fell through to his lane; wakes a lead's own webhook takes don't. A wake
that found the lane unavailable doesn't use a slot. The count is read from the wake
journal (which now records each note's device), so a restart keeps it, and the
check claims its slot before anything is awaited, so concurrent posts can't overrun
it. Past the bound the note still posts; its receipt says `reached: "none"` with
step `{via: "clankie", outcome: "limited"}`. The bound is fixed, not a setting.

## Evidence and limits

This record retains the webhook deadline and six app-note wakes per ten minutes. These are version-specific observations or bounded implementation choices, not a new measurement of optimal defaults. This documentation update does not rerun their original proof or change their status.

## Revisit when

Revisit when webhook providers, app traffic or measured wake costs change; compare accepted/deferred deliveries and note volume, keeping authenticated sender attribution and no automatic instruction authority.
