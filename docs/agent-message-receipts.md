# Agent message receipts

A connected lead can retain a message's delivery identity and look up its
progress later:

```json
{ "agent": "herdr:SEAT", "message": "Run the scoped check", "receipt": true, "requestId": "CALLER_UUID" }
```

Pass that object to `message_agent`. Keep the returned `receiptId` alongside the
usual send status. `message_agent_status({receiptId})` reads the receipt. The
owner can inspect it with:

```sh
clankie connector message-status RECEIPT_ID --json
```

An optional UUID `requestId` reconciles an uncertain original. Its target,
message and committed attachments stay fixed. Recovering that key reads the
original result; a receipt is not permission to resend.

| Stage       | Required evidence                              |
| ----------- | ---------------------------------------------- |
| `queued`    | Native queue acceptance                        |
| `delivered` | Native handoff or consumption acknowledgment   |
| `read`      | A native turn-start event for that exact input |
| `acted_on`  | Correlated successful native completion        |
| `answered`  | That completion includes an answer             |

Each observed stage has an observation timestamp and, when supplied by the
native connection, an occurrence timestamp. These stages describe handling;
they do not establish that the requested work achieved its goal. An answer may
be proven without a separately observed read timestamp. Pane activity, matching
text and service bookkeeping do not supply missing evidence.

## How far each route reports

The stages above are the most a receipt can say. What it says for one message
depends on the route that carried it, on the Mac and on linked machines alike:

| Route                                                        | Last stage reported      |
| ------------------------------------------------------------ | ------------------------ |
| A hired Codex seat; a Pi, Grok or Prime seat                 | `acted_on` or `answered` |
| A Claude or OpenCode seat                                    | `queued` or `delivered`  |
| A Codex session Clankie didn't start, through its app server | `delivered`              |
| A Codex session Clankie didn't start, through `codex queue`  | `queued`                 |

No route reports `read` yet: no harness connection surfaces a turn start tied to
one input, so a turn can be proven finished without ever showing as started.

A Claude or OpenCode completion carries no input ID, so it can't be tied to one
message. `codex queue` answers with acceptance alone and gives no input ID to
follow. A Codex session reached through its app server does return an ID, and on
the Mac a watch that records that exact turn can still add `acted_on` and
`answered`. Nothing follows it on a linked machine.

A receipt that stops early means unknown, never unread. Read the agent itself to
find out what happened, and don't resend.

Fleet seats carry their machine's prefix (`pc/term_…`). The checks above run on
that exact seat, and a changed occupant refuses the send.

Progress observation stays with the original native connection, occupant and
input ID while the original caller's authority remains valid. It ends when that
authority expires or is revoked, the recipient changes, or the host shuts down.
It records handling facts without creating a lead wake or another model turn.
An unsupported or lost native connection leaves the corresponding stages unknown.
Lookup only reads retained evidence; it does not attach to another connection or
start observation.

A receipt belongs to the original signed sending session. Another app, or a new
session of the same app, cannot read it. The same token can read already recorded
progress after a host restart while its permissions remain valid. The owner's
inspection command uses the owner's separate authority.

See the [CLI reference](cli.md) for fleet commands and the
[connected-lead guide](../.agents/skills/lead/reference/connected-leads.md) for the
connector workflow.
