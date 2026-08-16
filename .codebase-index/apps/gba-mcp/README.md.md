# apps/gba-mcp/README.md

Operating guide for the GBA MCP server —
the decisions live in ADR 0053 and friends;
this is how to run and drive it. Covers the
tool table (observe, start_action, pause,
resume, save/load state), movement and
dialog advice for drivers, and the
fail-closed refusal layers.

Deep sections explain possession (lease,
force-steal, expiry-renewal, the
`mcp_possessor` principal class), watching
a session via the activity surface, minted
checkpoints, the `clankie_say`/
`clankie_listen` Discord ports and why a
possessor cannot speak directly (no live
presence claim), the "possessor is itself,
not Clankie" owner decision, and the
liveness-based `body.lock` that keeps one
process on the body.
