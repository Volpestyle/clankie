# Product vocabulary

Clankie's TUI separates the person you talk to, the thread you read, and the
connection that reaches an agent. A saved thread is neither proof of an online
agent nor a complete history of connections.

| Term       | Meaning                                                                            | TUI entry               |
| ---------- | ---------------------------------------------------------------------------------- | ----------------------- |
| Chat       | A personal or workspace thread with Clankie                                        | `/chats`                |
| Agent      | A known identity; availability comes from the current fleet snapshot               | `/agents`               |
| Room       | A shared group channel or a Discord text/voice inspection view                     | `/rooms`                |
| History    | All retained threads, including ongoing chats and offline agent threads            | `/history`              |
| Session    | A harness execution record that can be read or resumed                             | `/sessions`             |
| Connection | Infrastructure that reaches agents or services: Swarm, Herdr, SSH, accounts        | `/connections`          |
| Thread     | The saved messages for a chat, agent, or room; `conversation` remains the API term | `clankie conversations` |

Agent rows show their Swarm connection or Herdr source and observed availability.
Availability is a snapshot, not a delivery guarantee. Discovery does not require
an existing thread; offline identities may have no messages to read. Multiple
identities can share a display name, so the picker also shows their identity IDs.

History does not imply completion or archival. Closing a retained thread remains
the existing explicit close operation; it is not a way to disconnect an agent.
Discord inspection stays read-only and does not grant authority to send there.

The TUI uses this separation now. Other clients retain their existing navigation;
these definitions provide the vocabulary for subsequent changes, not a claim
that those clients have already changed. The service contract and stored IDs
remain compatible. `/conversation`, `/conversations`, and `/chat` alias `/chats`;
`/history ID` reaches any retained thread. Existing agent-session CLI commands
remain supported, with `clankie sessions` as a clearer alias.
