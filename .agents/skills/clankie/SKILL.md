---
name: clankie
description: Work with Clankie when he is named or you are in a confirmed Clankie fleet, including agents started by hand in Herdr. Covers reaching him, reporting results and fleet etiquette; does not apply to unrelated Herdr sessions.
---

# Sharing a fleet with Clankie

Clankie is the persistent agent behind the fleet, not the harness in any one
pane. Being visible to him does not make you a hired worker or change who owns
your assignment. Resolve references from this skill's real source directory.

## Establish the context

Use this when Clankie is named, or the current session is known to be one of
his registered fleets. Useful clues:

- `CLANKIE_CONVERSATION_ID`, `CLANKIE_CONTROL_PLANE_URL` or
  `CLANKIE_SEAT_HARNESS` in the environment; inspect names without dumping secrets.
- Inside Herdr (`HERDR_ENV=1`), `herdr agent list` identifies his `clankie`
  console/seat. A remote fleet can be registered without a local Clankie pane.
- The workspace's `AGENTS.md`, handoff or Clankie repo markers
  (`apps/clankie`, `packages/protocol`, `.agents/skills/this-machine`) name him.

Confirm the session/destination from the assignment or registered fleet
inventory (`clankie herdr fleets` when available). Herdr alone, a saved chat,
or a `CLANKIE_*` variable does not prove a live connection or authority.
Without Clankie context, this skill does not apply.

## Reach him and report

If your session exposes `message_clankie`, use its documented channel to send
a question, blocker or result Clankie needs. Incoming
`<channel source="clankie" kind="message" ...>` events are addressed to this
agent; answer in your normal reply. Tool availability depends on the launch.

For the CLI path, use `clankie conversations list` and `show ID` to identify
the intended Clankie operator thread, then
`clankie send --conversation ID "Message"` (or `--stdin` for multiline text).
This requires a reachable service and local captain credential; a remote PC's
localhost is not the service on another machine. Follow the configured route
and [CLI contract](../../../docs/cli.md#send---conversation-id---delivery-steerqueue---attach-path-message----stdin).

Publish the result where the assignment says: its existing issue or result
file. In a file handoff, include outcome, evidence paths, commits and remaining
limits, then return the path in your final reply. Clankie can inspect native
history and arm a completion watch; idle/done is a cue to inspect, not proof
of success. Send actionable news without creating a second dispatch authority.

## Fleet etiquette and remote boundaries

- Never type into another pane to deliver automated briefs or messages. Use
  the supported harness channel/session API or the assigned handoff file.
- Never close panes, sessions or processes you did not create unless asked.
  Keep the current lead and deliverable owners; census visibility is not a hire.
- In Clankie's cross-fleet APIs, remote addresses use `<fleet>/`, for example
  `pc/w3:p1` or `pc/term_...`; local default IDs stay bare. Remote cwd and
  workspace grants belong to that machine, not your local checkout.
- The SSH route carries allow-listed Herdr census/pane reads, watches and
  seat/layout operations, plus on-demand native text history. It is not an
  arbitrary shell or server start/stop/update route. Remote native images stay
  off the local file publisher.
- Check the current control receipt and [ADR 0184 implementation addendum](../../../docs/adr/0184-clankie-leads-more-than-one-fleet.md)
  for terminal observe/control and reverse-mailbox coverage. Registration
  alone does not provide a worker channel, account grants or bundled skills.

## Deeper integration

Ask Clankie to use `hire_agent` with the intended harness, approved working
directory and, for remote work, `fleet`. Local Claude hires use the worker
channel; local Codex hires use the native app-server adapter. Inspect
`control.mode`, `control.reason` and any owner consent requirement rather than
faking hire environment variables or replaying a failed brief through keys.
See [fleet and hire guidance](../this-machine/reference/fleet.md).

For the design and current amendments, read
[ADR 0097](../../../docs/adr/0097-herdr-lead-is-the-companion-dashboard.md),
[ADR 0131](../../../docs/adr/0131-herdr-completion-watches-wake-the-operator-thread.md),
[ADR 0135](../../../docs/adr/0135-a-herdr-seat-is-a-conversation.md) and
[ADR 0184](../../../docs/adr/0184-clankie-leads-more-than-one-fleet.md).
