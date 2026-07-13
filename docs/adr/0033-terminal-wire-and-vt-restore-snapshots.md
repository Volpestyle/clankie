# ADR 0033: Strict terminal wire and exact VT restore snapshots

Status: accepted (VUH-867, 2026-07-12).

## Context

Runners, direct gateways, relay connections, Herdr adapters, and Apple clients
need one terminal contract before they independently invent message shapes.
The earlier in-process runner adapter keeps a bounded raw byte tail and labels
it a snapshot. That suffix can reconnect a byte stream but cannot reconstruct a
long-running alternate-screen TUI after its earlier drawing commands have been
evicted. It also does not freeze version negotiation, device authorization,
lease lifecycle, idempotent control, or deterministic gap behavior.

Terminal traffic crosses a compatibility and security boundary. PTY output and
ANSI sequences are untrusted, high volume, and sometimes sensitive. Input can
carry credentials or prompts. A relay may transport remote sessions but must
not become a second execution or authority owner.

## Decision

### Ownership and trust boundaries

The trusted runner owns the real PTY, ordered terminal history, headless VT
emulator, snapshot production, and exactly one renewable control lease. The
runner's TypeScript boundary owns sequencing, reconnect/resync, idempotency,
and lease state. It uses `@xterm/headless` plus `@xterm/addon-serialize` to turn
emulator state into a provider-neutral VT restore sequence.

An authenticated client may use the direct gateway or the relay path. Both
paths carry the same strict protocol. The relay authenticates and forwards but
never owns a PTY, VT state, replay cursor, or lease, and cannot grant control.

```mermaid
flowchart LR
  subgraph ClientBoundary[Authenticated device boundary]
    C[Terminal client<br/>observe/control device scopes]
  end

  subgraph TransitBoundary[Transport boundary]
    D[Direct authenticated gateway]
    R[Relay<br/>validated pass-through only]
  end

  subgraph RunnerBoundary[Trusted runner boundary]
    G[Terminal wire adapter<br/>strict v1 Zod parsing]
    O[TypeScript ordering + resync<br/>idempotency + one lease]
    V[@xterm/headless<br/>+ addon-serialize]
    P[Real PTY]
  end

  subgraph ControlBoundary[Semantic control plane]
    E[Mission events + bounded metadata]
  end

  C <-->|direct terminal data| D
  C <-->|relayed terminal data| R
  D <--> G
  R <--> G
  G <--> O
  O <--> P
  O --> V
  V -->|VT restore at exact boundary| O
  O -.->|lifecycle metadata only| E
```

### Strict versioned wire

`@clankie/terminal-protocol` owns strict Zod schemas and inferred TypeScript
types for every serialized client and server message:

- discovery, session capabilities, and authenticated device scopes;
- subscribe acknowledgement with an exact starting cursor, typed sequence
  cursor resume, resync request, and resync-required response;
- sequence-numbered output, geometry, and closure;
- geometry-bound VT restore snapshots at exact sequence boundaries;
- typed errors;
- nullable owner state and acquire/grant/renew/release/expiry/rejection lease
  lifecycle;
- attributed, idempotent input and resize plus applied/duplicate
  acknowledgements.

Every top-level message carries `protocolVersion: 1`; discovery also states the
supported version. Objects are strict. Unknown versions or fields, invalid
sequence/boundary values, malformed canonical base64, impossible capability
combinations, and missing control attribution fail closed.

The old `TerminalProvider`, `TerminalSession`, and `TerminalFrame` exports are a
deprecated source-local adapter compatibility surface. They are not accepted
by `TerminalWireMessageSchema` and do not define transport compatibility.

### Ordering and deterministic resync

Each terminal has one monotonic sequence shared by output, geometry, and
closure, starting at 1. The receiver uses one rule:

1. received sequence equals `lastAppliedSequence + 1`: apply it;
2. received sequence is at or below `lastAppliedSequence`: discard it as a
   duplicate;
3. received sequence is larger: stop applying and request resync from
   `lastAppliedSequence`.

The server replays only when it has the entire contiguous range. Otherwise it
sends `terminal.resync_required`, abandons that partial replay, and follows
with a current snapshot. No client fills a gap speculatively or applies later
frames while waiting.

Input and resize use a separate idempotency identity. The runner keys the
operation ledger by `(leaseId, operation type, operationId)`. An exact retry is
acknowledged as a duplicate without reapplication. Reusing an operation ID with
different content returns `operation_conflict`.

### Snapshot boundary

A v1 snapshot contains:

- terminal geometry;
- a `vt_restore_v1` base64-encoded VT restore sequence;
- `afterSequence: N` and `nextSequence: N + 1`;
- the literal assertion `parserState: quiescent`.

It represents visible VT state immediately after N. The client resets its
emulator, applies the restore sequence at the declared geometry, and next
accepts only N+1. The snapshot contains no historical raw byte tail.

The runner processes PTY bytes, geometry, and snapshot requests on one ordered
TypeScript lane. A framing/quiescence tracker surrounds xterm's write path and
tracks partial UTF-8 plus partial VT escape/control strings. The runner waits
for xterm write completion and publishes a snapshot only at a proven quiescent
boundary. This is required because visible-buffer serialization does not
serialize a decoder or parser's partial state. If the current boundary is not
quiescent, snapshot publication waits for a later sequence; replay continues
normally meanwhile.

The immutable v1 fixtures pin SHA-256 hashes and prove that snapshot-at-N plus
all frames after N produces the same explicit visible state as uninterrupted
consumption across alternate screen, cursor, SGR color, geometry changes, and
split UTF-8 output.

### Capability and lease semantics

Source capabilities and device authority are independent. Observation is
always explicit. A source can truthfully advertise no resume, no control
lease, no input, or no resize. Input/resize capability is invalid without
lease support; resume is invalid without VT restore snapshots. Discovery
returns the authenticated device's granted `observe` and/or `control` scope.

The runner owns at most one active lease. Lease requests, renewals, releases,
expiry, and rejection are explicit. Owner state is nullable and revisioned.
All lease and control requests carry `principalId`, `deviceId`, and
`clientInstanceId`; the connection's authenticated grants remain authoritative,
so attribution fields cannot self-grant a scope.

### Data-plane separation

PTY output, restore sequences, input, and resize are terminal data-plane bytes.
They never enter semantic mission events, structured logs, analytics, crash
reports, or ordinary support bundles. Credentials, tokens, and raw prompts are
never copied from terminal traffic into those systems. Bounded metadata—IDs,
sequence boundaries, geometry, capability flags, lease lifecycle, redacted
typed errors, and operation dispositions—may be recorded according to normal
retention policy. Evidence requiring terminal content uses a separately
authenticated artifact with explicit authorization and retention.

### Versioning policy

Additive optional fields may retain v1 only after every strict reader on the
intended compatibility path accepts them. Any breaking field, meaning,
ordering, lease, authorization, or restore-format change increments the
protocol version. During an approved migration, boundaries may dual-read the
current and immediately previous version, translate into the current in-memory
model, and single-write the current version. Unknown versions never receive a
best-effort interpretation. Stored fixtures remain immutable; a new version
gets a new fixture directory, manifest, and tested translator.

## Options weighed

- **Bounded raw byte tail as snapshot** — rejected because it cannot restore
  evicted alternate-screen or cursor/color state.
- **Screen cells or xterm objects on the wire** — rejected because they expose
  emulator implementation details and make non-TypeScript clients depend on
  xterm internals. A VT restore sequence is portable terminal behavior.
- **Sequence only raw output, not geometry/closure** — rejected because resume
  could reorder a resize or lose the terminal's final state.
- **Let each client infer gap behavior** — rejected because different duplicate
  and gap policies create divergent visible state.
- **Give the relay a PTY or lease cache** — rejected because it creates split
  execution/authority ownership and ambiguous expiry.
- **Put terminal bytes in mission events for convenience** — rejected because
  volume, secrets, retention, and prompt content would contaminate the
  semantic audit plane.
- **Snapshot at any xterm write callback** — rejected because a callback does
  not prove that partial UTF-8 or VT parser state is represented by addon
  serialization.

## Consequences

- Direct, relay, runner, Herdr, and product clients implement one reviewed
  compatibility boundary.
- Reconnection has a deterministic visible-state result and cannot silently
  bridge a gap.
- Read-only and limited sources can negotiate honestly without fake input or
  resize support.
- Human and automated control is attributable, renewable, single-owner, and
  safely retryable.
- Downstream runner work must replace the generic pipe/byte-tail adapter with a
  real PTY, headless VT serializer, quiescence tracker, and the frozen schemas.
- Protocol evolution requires explicit version/fixture work instead of
  permissive parsing.
