# apps/clankie/src/captain/tools.ts

The captain's authored `captainTools()` plus live-schema `browserTools()`. Each tool is a typed Pi definition returning JSON details; host context stamps room, actor, guild, channel and trigger-message identity, and attachable artifacts remain scoped to the current turn.

Capability groups: image/video generation; start/stop/observe/recall play; observe Discord shares, activity, and rooms; self-state and episode memory; host-grounded voice join/leave, reactions and threads; watch-surface start/stop; YouTube search and Discord music controls; Turbopuffer-styled tldraw ER/sequence diagrams. `connect-tools.ts` contributes Linear/email separately.

Non-operator lanes cannot observe the operator room. Browser catalog failure produces one honest `browser_unavailable` tool, and missing optional diagrams/music/actions remain explicit refusals rather than silently disappearing.
