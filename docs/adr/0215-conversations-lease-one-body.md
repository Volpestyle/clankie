# ADR 0215: Conversations lease one body

Status: accepted for engineering (2026-10-03; root review) ([VUH-1472](https://linear.app/vuhlp/issue/VUH-1472)).
Extends [ADR 0124](0124-one-self-has-many-local-threads.md). Preserves
[room inspection boundaries](0176-every-room-is-an-inspectable-conversation.md),
[room-owned harvests](0186-a-discord-room-harvests-its-own-workers.md),
[delivery receipts](0211-a-delivery-says-how-far-it-got.md), and
[Swarm retirement](0213-clankie-retires-swarm.md).

## Context

Parallel conversations belong to one Clankie, but his browser, Discord mouth,
voice membership, and play seat are shared mutable resources. Serializing a
single browser call does not prevent a second conversation from navigating away
between the first conversation's observations and actions. A turn ending does
not end a voice stay or a running game. Conversation inspection does not confer
permission to speak, reset, fork, or use another room's context.

## Decision

The service owns one lease registry. Its resource keys are `discord_mouth`,
`voice`, `browser`, and `play`; each has at most one owning conversation.
Acquisition uses a host-resolved stable conversation ID, never a model-supplied
room name, arbitrary pane ID, or retired Swarm actor. Different resources may
belong to different conversations. Observation of public status/catalogs does
not acquire the whole body. Reading another conversation's active browser page
is not public status and still requires the browser lease and existing access.

A lease adds no authority. Existing actor, room, machine, route, and tool grants
are checked independently at admission and again immediately before effects.
The captured conversation and lease token must still match at that boundary,
including after asynchronous discovery or queued browser work. A queued call
must never read a mutable turn context belonging to a later turn.

Acquisition, renewal, operation reservation, and release are serialized atomic
state transitions. An opaque unpredictable incarnation token fences release and
heartbeat as well as effects: an old owner cannot affect a later lease, even
when the same conversation reacquires it. The service persists claims before
admitting effects. Persistence errors fail closed. Only the single service owns
this store; its service lifetime lock prevents a second process from operating
it. It is not a distributed scheduling system.

A deadline ends permission to begin effects; it does not prove that earlier
external work stopped. Active operations remain blocking until their exact
completion is observed. Expired ongoing voice/play/browser sessions enter
`recovery_required`, retaining their owner and token. Heartbeat cannot resurrect
an expired claim. A service restart invalidates all old tokens and leaves
persisted occupied resources blocked until their body state is reconciled or
explicitly stopped through an authorized recovery action. Never infer safe
handoff from elapsed time, missing heartbeats, or a process replacement.

Discord text leases cover one admitted outbound operation through its receipt.
Uncertain sends keep the resource blocked until reconciled; lease handling never
retries delivery. Voice covers the complete joined stay, including speech and
stream changes. Play covers start through confirmed terminal session state.
Browser covers a browsing burst through confirmed close, including the REPL,
selected page and recording. Only the owner can renew or request ordinary stop;
owner-authorized recovery is explicit and records the original claimant. An
independent transport-owned voice stay needs its own exact conversation binding.

A conflict returns typed `busy` with resource, owning conversation, state, and
allowed explicit `queue`/`ask` actions. It includes no other room's transcript,
actor identity, prompt, or private display name. Queueing is an explicit bounded
request scoped to requester, resource, current holder token and deadline. It
never automatically runs an effect or transfers a lease. Availability wakes the
requesting conversation to reconsider with fresh authority. Asking sends only a
requester-authored bounded request to the holding conversation, or an explicitly
designated head when the original is unavailable; no global/default-room
fallback and no context copying. Existing delivery receipts describe progress.

Watches continue to wake the conversation that armed them, with current grants
rechecked. Workers retain the hiring conversation as their owner; completion or
escalation targets that owner or its explicitly designated head. Neither fact
requires a body lease for mere computation. Shared memory keeps host-stamped
source conversation provenance and existing visibility restrictions. Sharing a
memory never imports another room's transcript or elevates its instructions.

API and CLI expose lease status and explicit acquire/renew/release/queue/ask
operations with exact conversation identity. Inspection permission alone permits
only inspection. The app displays one Clankie with conversation threads beneath
him and resource-held badges; a parallel seat is not another Clankie contact.

```mermaid
flowchart LR
  A[Conversation A] --> Authority[Existing authority and exact route checks]
  B[Conversation B] --> Authority
  Authority --> Lease[Atomic resource lease and incarnation fence]
  Lease -->|matching owner and active token| Effect[Body effect / ongoing session]
  Lease -->|conflict| Busy[Typed busy with holder conversation]
  Busy --> Request[Explicit scoped queue or ask]
  Request --> Wake[Exact conversation / designated head]
  Effect --> Reconcile[Receipt / termination / recovery]
  Reconcile --> Lease
```

## Consequences and verification

Two seats may think concurrently while conflicts over one resource are visible
and recoverable. Holding voice does not monopolize browser or play. A stuck or
uncertain operation reduces availability until reconciled, rather than silently
letting a second conversation take over. General scheduling, transcript merging,
new worker launch paths, and new authority are outside this decision.

Deterministic verification covers simultaneous acquisition, stale-token ABA,
expiry during an operation, async identity changes, restart recovery, denied
authority, scoped queue/ask and preserved watch/memory provenance. A real two-seat
lease conflict, Discord/voice/play lifetime, and private app presentation remain
separate acceptance evidence; deterministic tests do not claim a live model run.
