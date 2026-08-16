# @clankie/interactive-environment

Provider-neutral contracts shared by the GBA body, Discord presence, rendered
surfaces, and activity observation. The package defines session phases, leases,
commands, action handles, observations, semantic events, bounded telemetry
references, and lane-scoped tool exposure.

Semantic event data is a closed, bounded union of state-transition payloads.
Raw ticks, chunks, packets, audio, and video are rejected from the semantic
plane and travel only as bounded `EnvironmentTelemetryReferenceSchema` artifact
references. Discord presence tool exposure single-writes schema v2 lanes while
dual-reading legacy `tui` supervision as the v2 `operator` lane.

Session and lease v2 contracts use strict profile-specific resource bounds. The
`gba_emulator` profile pins the core, savestate identity, frame/input budgets,
and capabilities. The `legacy_v1` profile exists only to read persisted v1
sessions and normalize them to v2; new sessions write v2. Action/result/event
contracts remain v1.

The clankie service remains authoritative. Models receive no credentials,
cannot mint leases, and cannot expand an action catalog. GBA gameplay tools
appear only in the active `gameplay` lane; operator and Discord lanes retain
their bounded supervision/presence surfaces. Runtime and emulator details stay
behind the contracts in this package.

`ActivityObservationSnapshotSchema` defines present-tense self-observation for
active activities. The first `gba_emulator` variant separates bounded
`selfAuthored` objective/intent/commentary from the `runnerObserved` settled
outcome/effect/progress the service records, and admits only a framebuffer
digest, never frame bytes.
`ActivityObservationReadSchema` distinguishes a matching snapshot, a live
session whose first turn is still pending, and no live activity. This is a read
contract, not an environment command or capability projection.
