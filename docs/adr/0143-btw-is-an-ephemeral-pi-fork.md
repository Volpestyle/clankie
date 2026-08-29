# 0143. `/btw` is an ephemeral Pi fork

Accepted 2026-08-29.

## Context

The operator sometimes needs a contextual question answered without steering
or cluttering the main thread. Pi already knows how to clone the current leaf
of a session tree. Clankie only needs to coordinate that native branch with
his server-owned conversation and console lifecycles.

## Decision

`/btw [question]` (alias `/side`) creates and selects one ephemeral child of the
current non-seat operator conversation. The captain opens the parent's Pi JSONL
tree in the child's session directory and calls Pi's native
`createBranchedSession` at the current leaf. It appends one hidden custom message
that marks all inherited history as reference-only, and the child system prompt
keeps side work lightweight, non-mutating by default, and outside Herdr.

```mermaid
sequenceDiagram
    participant TUI as Console
    participant Store as Conversation store
    participant Pi as Pi SessionManager
    TUI->>Store: fork(parentConversationId)
    Store->>Pi: createBranchedSession(current leaf)
    Pi-->>Store: child JSONL tree
    Store-->>TUI: ephemeral child conversation
    TUI->>TUI: keep parent transcript; append side turns
    TUI->>Store: Ctrl+C → close(child)
    Store->>Pi: abort active child turn, dispose child
    TUI->>TUI: restore parent transcript and unread events
```

The child has its own revision, public event log, and Pi session, but no durable
resume promise. Only one child may be open from a parent, nested side forks are
rejected, and the parent remains protected from retention or close while its
child exists. Ctrl+C aborts an active child run, deletes the child directory,
selects the parent, restores the exact parent UI snapshot, and replays any
events that reached the parent while the side conversation was open. Service
startup deletes orphaned side children because no console can resume their UI
lifecycle.

## Consequences

- Main-thread history, goal state, and replay cursor stay untouched by side
  turns.
- The implementation reuses Pi's session-tree semantics; Clankie owns only the
  parent/child metadata, safety boundary, transcript swap, and discard action.
- A parent must have a persisted Pi session, so `/btw` becomes available after
  its first completed response.
- Only read-only/status slash commands remain available inside the side
  conversation; configuration, navigation, skills, and fleet controls stay on
  the main thread.

Creating a normal retained conversation and copying messages through the public
event log are rejected: both duplicate Pi's branching semantics and either keep
the detour permanently or lose internal tool/session context.
