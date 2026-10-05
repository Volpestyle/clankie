# Conversation preference questions

2026-10-04. Implementation checkpoint on `sol/vuh-1538-questions`; not released.
The mobile/world response path and owner-confirmed project creation are separate work.

Clankie can ask one text or choice question in an authenticated owner conversation
working in an existing local directory. The tool returns the pending request
immediately. An answer is preference/context, never configuration approval,
project enrollment, tracker initialization or a settings change.

The service gives every question and option an opaque immutable ID. Its saved
binding includes the conversation incarnation and canonical workspace directory
identity. An authenticated operator or a currently active Take Control device on
this service can answer, including a device different from the initiating TUI.
A captain credential alone, a room message, pane metadata, or a read-only device
cannot answer. Native-seat, room, global and side conversations are excluded.
Persisted native ownership excludes a question even while its receiver is offline.
A native takeover cancels a pending question before answer continuation.

The operator TUI uses `/question` to fetch and display the current question.
`/question answer 1` selects the first displayed option; `/question text ...`
supplies text where allowed, and `/question cancel` cancels explicitly. These
commands bind to the displayed request and revision. A conflict requires reading
the question again. Ordinary chat text such as “yes” is never a structured answer.

The CLI exposes the same authenticated contract:

```text
clankie conversations questions CONVERSATION [--request REQUEST_UUID]
clankie conversations answer CONVERSATION REQUEST_UUID --incarnation UUID --revision N --option OPTION_UUID
clankie conversations answer CONVERSATION REQUEST_UUID --incarnation UUID --revision N --text TEXT
clankie conversations answer CONVERSATION REQUEST_UUID --incarnation UUID --revision N --stdin
clankie conversations cancel-question CONVERSATION REQUEST_UUID --incarnation UUID --revision N
```

The `input_get`, `input_answer`, and `input_cancel` dispatcher operations use strict
bounded DTOs. The snapshot carries incarnation, option IDs, revision and terminal
receipt. Existing `input_requested` and `input_resolved` events retain their
original fields exactly so older strict clients can continue reading tails.
Updated clients fetch the snapshot on these lifecycle events and after recovery;
activity or unrelated tool events do not mean a question was answered. The
snapshot also works when the original event is outside retained history.

```mermaid
sequenceDiagram
    participant C as Clankie
    participant S as Conversation service
    participant O as Owner TUI or device
    C->>S: request_user_input (preference)
    S-->>C: Pending request with immutable IDs
    S-->>O: input_requested (legacy event)
    O->>S: input_get
    S-->>O: Typed question and revision
    O->>S: input_answer (request, incarnation, option, revision)
    S->>S: Reauthenticate and commit answer with run ID
    S-->>O: Submitted receipt; continuation accepted
    S-->>O: input_resolved (legacy event)
    S->>S: Revalidate owner and workspace before execution
    S->>C: Attributed preference continuation
```

Accepted means the answer and continuation run ID were stored, not that Clankie
has executed or answered. A duplicate identical answer returns the original
receipt and run ID, including after the conversation revision moves. A different
answer to the consumed request is refused. A storage failure after commit can
leave the answer submitted with a failed continuation; inspect its receipt.
The client never automatically resubmits an uncertain answer.

The service keeps at most one pending question and a bounded recent receipt set.
An evicted or unknown request cannot start a new run. Reset rotates incarnation;
reset, explicit cancellation, known owner revocation, workspace replacement and
native takeover invalidate pending questions. Expiry and credential rotation are
checked on later use. A displayed idle question is not proof of current authority.
Restart cancels pending questions and fails orphaned accepted continuations.
It never replays execution. Snapshot reads do not reconstruct trimmed history.

A real owner workspace turn also receives a read-only current project-membership
fact. Registered Git worktrees count; ambiguous, changed or unverified facts are
reported as unknown. This context does not enroll the directory or impose a
scripted tracker, role or size questionnaire. Clankie chooses what to ask.
