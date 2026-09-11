# ADR 0111: A console opens the main conversation by default

Status: accepted (James, 2026-08-16). Refines the operator lifecycle from
[ADR 0032](0032-conversation-scoped-operator-lanes.md) without adding another
session identity.

## Current status (2026-08-26)

Per-turn tool-shape counters live in `~/.clankie/captain/turn-settled.jsonl`,
outside the conversation directory the retention pass deletes. Presence already
uses `captain.turn.settled` in `~/.clankie/events.jsonl` for idle/waiting_user,
so the metrics line is a sibling captain file rather than a second payload
under the same domain-event type.

## Context

Opening the console is a request to talk to Clankie, not to create another
conversation. The service's default global conversation provides a stable
startup target without persisting a second local selection record. Operators
choose a fresh context explicitly through `/new` or `/reset`.

Deleting a conversation when its TUI exits is unsafe. Another console or device
may be attached, and an accepted turn deliberately survives a detached client.
Keeping every detached conversation forever is unsafe in the other direction:
the public event log and Pi tree are append-only evidence and otherwise grow
without a storage lifecycle.

## Decision

A normal `clankie` launch selects the existing default global conversation from
any directory. Startup never creates a conversation; a missing or ambiguous
default is an error. `clankie --chat <conversationId>` selects that retained
conversation instead. `/conversation` switches rooms, `/cd` selects a workspace
conversation, and `/new [title]` starts a fresh conversation in the current scope.

The conversation picker may explicitly close an inactive, non-default
conversation. Close uses the registry's whole-directory removal path, so its
public event log and Pi session tree leave together. The service refuses close
while a turn is active and always protects the default global conversation.

The conversation remains the only durable model-session identity. It owns one
Pi session tree and one public event log in the same directory. The TUI keeps
only an in-memory selected id. Its durable tail file is a delivery checkpoint,
not a session or a transcript cache: one surface id and at most 256 recent
conversation cursors. Because the fullscreen transcript is process memory, an
explicit selection hydrates it from the retained log boundary before incremental
tailing resumes at the newly rendered cursor.

```mermaid
flowchart LR
    Start[TUI process starts] --> Choice{--chat id?}
    Choice -->|yes| Resume[Select retained conversation]
    Choice -->|no| Default[Select existing default global conversation]
    Resume --> Room[Conversation directory]
    Default --> Room
    Room --> Meta[meta.json]
    Room --> Events[events.jsonl]
    Room --> Pi[one Pi session tree]
    Exit[TUI exits] -. no deletion .-> Room
    Picker[Picker x close] -->|inactive and non-default| Delete
    Retention[Retention pass] -->|inactive and outside bounds| Delete[Delete whole directory]
    Room --> Retention
```

Retention removes inactive, non-default conversations as whole directories.
The registry retains at most 64 conversations, 30 days of inactivity, and 256
MiB across retained conversation directories. It protects the conversation
being created or settled, every active conversation, and the required default
global identity; those protected directories can temporarily be the remaining
overage. Retention runs at service boot, conversation creation, and turn
settlement.

Each public event log retains at most 500 events and trims back to 400 as one
atomic rewrite. Cursors remain monotonic. A client behind the retained boundary
gets the existing typed `cursor_expired` recovery and resumes from the returned
cursor. When a conversation is pruned, its public events and Pi evidence leave
together and any cached in-memory Pi lane is disposed.

## Alternatives

- Persist the last selected conversation per workspace: rejected because a new
  process would need a second durable pointer instead of the service default.
- Delete on TUI exit: rejected because process ownership does not match shared
  conversation ownership and can destroy detached work.
- Automatically rotate Pi sessions on launch: opening another surface must not
  reset shared context. Explicit `/reset` archives the old context under
  [ADR 0169](0169-conversation-context-can-start-fresh.md).

## Consequences

- Starting `clankie` resumes the main room; fresh context is an explicit choice.
- Exiting the console is nondestructive, so accepted turns and other attached
  surfaces remain safe.
- Recent conversations remain inspectable and resumable, while their logs have
  explicit count, age, byte, and event bounds.
- The picker closes an unwanted inactive conversation immediately without
  weakening the protections around active work or the default global room.
- The non-deletable default global conversation remains available to clients
  and is the normal TUI startup target.
