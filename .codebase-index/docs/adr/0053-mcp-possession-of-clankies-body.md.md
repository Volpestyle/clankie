# docs/adr/0053-mcp-possession-of-clankies-body.md

`apps/gba-mcp` publishes the GBA body as MCP
tools so an external harness (Claude Code, Codex)
can drive it — a consumer of the existing action
surface, refused by the same machinery that
refuses scripts.

Read for the possession model: observation is
lease-free, acting/speaking/listening take the
lease (suspending the resident loop, `force` to
steal, expiring on idle); a possessor holds no
Discord gateway so speech and hearing are ports
through the bridge; hearing is push-only and
downstream of consent (the bridge retains no
transcripts). Owner ruling: possession is logged
operator-side, not disclosed to the room — with
the conditions for revisiting recorded. The body
lockfile (`acquireBodyLock`, liveness-expired) is
the cross-process mutex.
