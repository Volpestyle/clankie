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

Clankie does not post worker reports to a lead's webhook. Reports stay in his
lead threads for `read_inbox` and `read_reports`; a later change may wake a
lead when reports arrive, on the same stored webhook.

## Consequences

- Updating the Mac's Clankie can be a job: Claude Duet asks Grok Bot to run
  `clankie restart all` and report health, which a runner without the
  unlocked Keychain can't do.
- A lead's webhook key in the broker is as strong as the lead it wakes. A
  connected app that can wake Grok Bot can ask it for anything Grok Bot can
  do; the lead weighs a job as another app's request, never the owner's word.
- A wake whose webhook doesn't answer in time may still have arrived. The tool
  says so, and the sender checks the board before sending it again.
