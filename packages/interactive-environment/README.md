# @clankie/interactive-environment

Provider-neutral contracts for durable embodied environments and the initial
Minecraft Java profile. The package defines session phases, leases, commands,
action handles, observations, semantic events, bounded telemetry references,
and deterministic lane-scoped tool exposure.

The control plane and runner remain authoritative. Models receive no
credentials, cannot mint leases, and cannot expand the action catalog. A
dormant Minecraft session exposes only lifecycle tools. Gameplay tools appear
only in the active `gameplay` captain lane; TUI and Discord lanes retain a
small supervision surface.

Mineflayer and Paper types stay behind runtime adapters. This package is the
stable protocol boundary those adapters implement.
