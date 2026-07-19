# @clankie/interactive-environment

Provider-neutral contracts for durable embodied environments: Minecraft Java,
the deterministic PokeMMO simulator, and Discord presence (ADR 0024). The package defines session phases, leases, commands,
action handles, observations, semantic events, bounded telemetry references,
and deterministic lane-scoped tool exposure.

Semantic event data is a closed, bounded union of state-transition payloads.
Raw ticks, chunks, packets, audio, and video are rejected from the semantic
plane and travel only as bounded `EnvironmentTelemetryReferenceSchema` artifact
references. Discord presence tool exposure single-writes schema v2 lanes while
dual-reading legacy `tui` supervision as the v2 `operator` lane.

Session and lease v2 contracts use strict provider-profiled resource bounds.
Boundaries dual-read the frozen Minecraft-shaped v1 contract, normalize it, and
single-write v2; PokeMMO fields never reuse dimensions, block quotas, or
Minecraft combat policy. Action/result/event contracts remain v1.

The control plane and runner remain authoritative. Models receive no
credentials, cannot mint leases, and cannot expand the action catalog. A
dormant embodied session exposes only lifecycle tools. Minecraft and PokeMMO
simulator gameplay tools appear only in the active `gameplay` captain lane; TUI
and Discord lanes retain a small supervision surface. The PokeMMO live boundary
contains only read-only observation/coaching names and no live adapter or action
capability.

Mineflayer and Paper types stay behind runtime adapters. This package is the
stable protocol boundary those adapters implement.
