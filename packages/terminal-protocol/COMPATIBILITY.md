# Terminal protocol v1 compatibility report

The serialized terminal wire accepts only `protocolVersion: 1`. Every message
is a strict Zod object: unknown versions, unknown fields, malformed canonical
base64, impossible snapshot boundaries, and unattributed control requests fail
closed. Additive optional fields may remain in v1 only after the strict readers
are updated; breaking shape or semantic changes require a new version and an
explicit translator.

Canonical base64 validation and the exported byte encode/decode helpers use
only JavaScript strings and `Uint8Array`; they do not require Node `Buffer` or
browser `atob`/`btoa` globals. Public `safeParse` calls therefore return a Zod
result rather than throwing when a Node global is absent.
The deprecated adapter helper also preserves its empty-frame round trip, while
the strict serialized wire continues to reject empty byte payloads.

## Capability combinations

| Source shape        | observe | resume | VT snapshot | lease | input | resize |
| ------------------- | ------: | -----: | ----------: | ----: | ----: | -----: |
| Read-only stream    |     yes |     no |          no |    no |    no |     no |
| Replayable observer |     yes |    yes |         yes |    no |    no |     no |
| Input-only control  |     yes |    yes |         yes |   yes |   yes |     no |
| Full PTY control    |     yes |    yes |         yes |   yes |   yes |    yes |

`input` or `resize` without `controlLease` is invalid. `resume` without a VT
restore snapshot is invalid. Discovery separately reports the authenticated
device's granted `observe`/`control` scopes, so a capable source does not imply
that a device is authorized to control it. `terminal.subscribed` declares
whether initial delivery is live-only, replay, or a following snapshot, and
pins the subscription's starting sequence cursor.

Discovery, subscription acknowledgement, resync-required delivery, and every
snapshot carry explicit `open` or `closed` lifecycle state. Closed state
includes the original sequenced close identity and remains authoritative after
that stream frame leaves replay retention. A closed snapshot's closure
sequence is at or before its exact snapshot boundary.

`terminal.capabilities_changed` pushes the complete current capability set and
its positive monotonic revision to each attached subscription. A client applies
a revision greater than its last applied capability revision and ignores an
equal or lower revision as a duplicate. A revision gap does not affect terminal
data sequencing: the complete pushed value supersedes older capability state.

## Ordering compatibility

All data-plane output, geometry, and closure messages share one per-terminal
sequence. A receiver applies exactly `lastAppliedSequence + 1`, discards any
sequence at or below `lastAppliedSequence` as a duplicate, and stops applying
on a larger sequence while it requests resync. A snapshot restores visible VT
state through its `afterSequence` boundary; the first subsequent frame is
exactly `nextSequence = afterSequence + 1`. Boundaries are published only when
the VT parser is quiescent, so no partial UTF-8 or escape parser state exists
outside the restore sequence.

## Immutable replay fixtures

| Fixture                 | SHA-256                                                            | Coverage                                |
| ----------------------- | ------------------------------------------------------------------ | --------------------------------------- |
| `alternate-screen.json` | `7fe67e4d7909983573f9d533905ed55ab392bc5de2662e34e74e4a3fee97d8ae` | alternate buffer, cursor, SGR color     |
| `cursor-color.json`     | `19179169eb9d66ae0c2df88ab0dea210c71ce7eb8e11fa2160f54a604ef4a208` | cursor placement, color retention/reset |
| `resize-utf8.json`      | `d6ddb280d71bac9e2b8e8497cbc62b0d108834ae976ca238e80de76d1e8a998f` | geometry replay, split UTF-8 output     |

The test suite pins these hashes, validates each fixture strictly, compares the
snapshot state at N with uninterrupted state at N, then applies every frame
after N and compares the final visible state with uninterrupted consumption and
the fixture's explicit expected screen. These fixtures prove wire ordering,
boundary, geometry, and reconstruction invariants against the package's
deterministic reference terminal. They do not claim that their hand-authored
restore bytes are output from `@xterm/headless` and `@xterm/addon-serialize`.
VUH-868 owns real serializer production and conformance evidence at the runner
boundary without exposing xterm objects in this public protocol package.

## Public app-consumer inventory

The named public schemas and inferred types cover discovery/list/get
capabilities, subscribe/resume/resync with an opaque branded replay cursor,
exact-boundary snapshots, ordered output/geometry/closure, explicit lifecycle,
revisioned capability changes, owner/lease lifecycle, attributed idempotent
input/resize, errors, and client/server/wire unions. `TerminalSequenceDisposition`
and `classifyTerminalSequence` define duplicate-ignore and gap-resync. The three
immutable fixtures above are the v1 golden replay inventory. Renderers consume
only reset bytes plus geometry/boundary and subsequent feed bytes; transport,
authentication, and leases remain outside the renderer.

## Pre-v1 adapter compatibility

`legacy.ts` retains the old in-process `TerminalProvider`, `TerminalSession`,
and rolling-byte-tail `TerminalFrame` exports only so the current runner keeps
compiling while VUH-868 replaces it. Those deprecated shapes are not accepted
by `TerminalWireMessageSchema`, are not a serialized compatibility promise,
and must not cross a direct or relay transport.
