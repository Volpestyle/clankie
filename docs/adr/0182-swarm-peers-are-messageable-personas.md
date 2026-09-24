# 0182. Swarm peers are messageable personas

Status: accepted (2026-09-24). Extends [ADR 0181](0181-clankie-is-independent-of-his-connections.md).

## Decision

An enrolled peer on an existing Swarm connection is a contact even when it has
no Herdr seat. The host projects peers into the existing persona catalog; opening
one creates the existing persona DM. This reuses conversation history, device
relay authorization and app rendering instead of creating a second chat service
or inventing terminal addresses.

Each Swarm persona pins its captain conversation, named connection, coordinator
fingerprint, scope, actor and generation. The fingerprint binds the configured
endpoint, scope and captain actor; the trusted coordinator owns session-generation
continuity in its durable database. Discovery excludes the binding's own
actor and reads up to 500 peers across existing bindings. Persona storage retains
at most 1,000 records. A new generation has a distinct contact; old threads remain
readable. Names and labels never establish identity or merge contacts with a
Herdr character. Terminal links require a real terminal binding.

```mermaid
sequenceDiagram
  participant P as App / CLI / TUI
  participant C as Clankie conversations
  participant S as Selected Swarm coordinator
  participant A as Enrolled peer
  P->>C: Read fleet, open Swarm persona DM
  P->>C: Submit message at expected revision
  C->>S: Send with stable run ID, thread ID and recipient generation
  S->>S: Atomically verify current recipient session
  S->>A: Lease message through the peer inbox
  A->>S: Reply with the same thread ID
  S->>S: Record authenticated sender generation
  S->>C: Deliver reply
  C->>C: Match connection, peer generation and thread; persist once
  C->>S: Acknowledge after persistence
  C-->>P: Existing conversation tail
```

Outgoing messages use the normal durable turn queue, without a captain model
call. The coordinator checks the pinned recipient generation at acceptance.
Disconnected connections and replaced sessions fail; there is no fallback or
implicit spawn. A failed or interrupted run is visible in its conversation and
is not silently resent under a new command ID. An already accepted coordinator
message cannot be recalled by cancelling its local turn.

Incoming envelopes carry the sender generation recorded at acceptance, never a
lookup of the sender's current session. Only matching peer/thread/connection
identities enter the DM. Message IDs persist beside the conversation and on its
events, so redelivery after an interrupted checkpoint cannot append another copy.
The coordinator acknowledges only after that durable projection. A delayed reply
from an older generation belongs to its original thread.

The same actor inbox carries ordinary captain context. When the captain is busy
or unbound, the host leases only known contact thread IDs; ordinary messages keep
their attempts. This lets DMs arrive independently without starting a captain turn.
Older coordinators without the session-identity feature are unavailable to this
contact path.

## Surfaces and limits

The public `fleet`/`personas`, `create`, `send` and `replay` operations carry this
flow. [CLI/TUI commands](../cli.md#swarm-coordination) use that same contract.
The app shows Swarm reachability independently of terminal presence, clears it
on service disconnect, and retains offline Swarm threads with history.

Commons placement and shared channel rounds still require execution seats.
Contact discovery does not infer a peer's terminal or grant provider access;
[worker account grants](../worker-access.md) remain a separate authorization.
Coordinator upgrades require a deliberate restart of existing owners.
