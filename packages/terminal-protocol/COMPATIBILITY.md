# Terminal protocol v1 compatibility report

The serialized terminal wire accepts only `protocolVersion: 1`. Every message
is a strict Zod object: unknown versions, unknown fields, malformed canonical
base64, impossible snapshot boundaries, and unattributed control requests fail
closed. Additive optional fields may remain in v1 only after the strict readers
are updated; breaking shape or semantic changes require a new version and an
explicit translator.

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
the fixture's explicit expected screen.

## Pre-v1 adapter compatibility

`legacy.ts` retains the old in-process `TerminalProvider`, `TerminalSession`,
and rolling-byte-tail `TerminalFrame` exports only so the current runner keeps
compiling while VUH-868 replaces it. Those deprecated shapes are not accepted
by `TerminalWireMessageSchema`, are not a serialized compatibility promise,
and must not cross a direct or relay transport.
