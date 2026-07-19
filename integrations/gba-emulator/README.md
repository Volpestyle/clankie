# @clankie/gba-emulator

Governed Game Boy Advance emulator embodiment for the `gba_emulator`
environment profile ([ADR 0039](../../docs/adr/0039-gba-emulator-embodiment-and-deterministic-core-boundary.md)).

`GbaEmulatorAdapter` is an `EnvironmentAdapter` dispatched through
`@clankie/environment-runtime`, so every action inherits the runtime's
register-before-dispatch idempotency, runner leases, pause/cancel, and
emergency-stop fencing — the adapter owns no action loop. It validates the
strict emulator contract from `@clankie/interactive-environment`, enforces
per-lease input/frame bounds and capabilities, drives the pinned deterministic
core, and records a bounded hash-chained evidence trace.

The core behind the adapter boundary in this slice is
`DeterministicGbaCoreDouble` — clearly-labeled **test infrastructure, not a
product simulator**: a controllable, deterministic stand-in for a pinned real
mGBA core, anchored on a savestate identity digest and an RNG seed. The
adapter-facing surface (button input consuming frames + typed RAM-derived
state + framebuffer/RAM digests) is the seam where the libmgba-backed core
replaces it next slice.

`driveGbaScenario` is the state-derived driver: each decision is a pure
function of the latest observations (`decideNextGbaAction`), decisions change
when the observed state changes, and uncertain or stale state pauses the
session and fails closed instead of replaying input. The frozen scenario under
`scenarios/emulator/verdant-path-trainer-battle/v1` replays byte-identically:
report, evidence trace, and decision trace.

The adapter is local-only: it performs no network I/O, holds no network or
live-service capability (`GBA_EMULATOR_CAPABILITY_BOUNDARY` cannot represent
one), and rejects all connection/credential material. ROM, BIOS, and savestate
bytes never enter fixtures, events, or reports; image evidence uses bounded
`artifact://` frame references.

- `pnpm --filter @clankie/gba-emulator test`
- `pnpm --filter @clankie/gba-emulator fixture:check`
- `pnpm --filter @clankie/gba-emulator scenario:validate [outputDir]`
