# ADR 0308: A cleared session is rediscovered, and the connector's detection is the owner's

Status: Accepted by James, 2026-10-31. Amends
[ADR 0301](0301-claude-reaches-the-fleet-through-a-narrow-connector.md). Narrows
[ADR 0207](0207-work-records-and-native-agent-delivery.md) for one operator
redelivery, and only when Herdr detection is on.

## Context

A connector called `message_agent` on a Claude Code pane immediately after
`/clear`. The pane id was unchanged, so the call still resolved a seat, but
both sends came back `unconfirmed` ("may have reached … but wasn't confirmed")
and `read_agent` showed an idle, empty prompt. A following `start_agent` in
that conversation was refused with "The conversation's original agent has
changed."

`/clear` and a restart keep the Herdr pane and terminal and replace the native
session, so the occupant id changes. Delivery is fenced to the session that
was current when the send began (ADR 0207): an unconfirmed receipt is never
resent, and a later session is not proof the message arrived or that it did
not. The Herdr session source also replaced the service's reason with one
generic sentence. Hiring compared the conversation's stored session with the
process now in the pane and treated a new session id as a different agent.
The seat id itself was not stale.

## Decision

- **One rediscovery for an operator send, when Herdr detection is on.** If a
  send to a Herdr seat is not confirmed, the service reads the pane's current
  session. A transcript that already contains the message is reconciled and
  nothing is sent again. An idle, done, or resting session whose transcript
  does not contain it is sent once more, and that receipt is marked
  rediscovered. A second miss, a transcript that cannot be read, a seat that
  is not idle, or no coding session at all is `undelivered` with a sentence
  that says which of those it was. Nothing further is sent. Peer delivery,
  stable receipts, and sends while detection is off keep ADR 0207 unchanged:
  an uncertain original is not resent.
- **The same switch rebinds a lead.** A proven session in the same pane, on
  the same terminal, running the same harness, replaces the conversation's
  stored native source and hiring continues. A different harness or terminal,
  a missing proof, or a process that has not reported a session yet is still
  refused. Detection off keeps today's refusal.
- **The connector says the reason.** `seat_undelivered` stays `not_delivered`
  and is an MCP error whose text is the service's sentence.
  `seat_delivery_unconfirmed` keeps the service's own detail instead of a
  generic "may have reached."
- **Detection is two owner switches, defaulting to today's behavior.**
  The multiplexer switch is a list of adapters. Herdr is the first this
  service knows; the file stores a record of ids so another adapter does not
  need a schema change, and an id this service does not know is refused.
  `clankie connector detect on|off herdr` discovers every Herdr session,
  including one just cleared or restarted, or lists and reaches none of them.
  `clankie connector serve on|off APP` serves that connected app or refuses
  every tool from it. Both live in `connector-detection.json` (mode 0600) in
  the state root, beside prompt answers. Herdr starts on. Every app starts
  served. A missing or unreadable file reads the same way, so a bad file does
  not hide the fleet. The relay reads the file through the captain bearer and
  fails closed when that read fails. Hiring a new agent is not detection and
  stays available while Herdr discovery is off.

## Consequences

- An operator message can be delivered twice when the first send actually
  landed and the transcript had not caught up yet, the agent looked idle, and
  Herdr detection was on. The redelivery is one shot. If the transcript cannot
  be read, nothing is sent again.
- A receipt marked rediscovered is a new optional field. An older service that
  reads the file with a strict schema treats the journal as unreadable and
  blocks delivery until the file is reconciled.
- Turning Herdr detection off stops listing and reaching sessions. It does not
  stop `start_agent`. Turning an app off refuses that app's connector tools
  until `clankie connector serve on` names it again.
