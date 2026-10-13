# VUH-2213: idle Minecraft status polling

Tracks: https://linear.app/vuhlp/issue/VUH-2213

## Cause and call rates

Service startup registers and activates `minecraftExtension` in
`apps/clankie/src/index.ts`. Its `MinecraftCapture.start()` schedules a tick
immediately and then 500 ms after each completed tick. The capture source in
`integrations/minecraft/src/extension.ts` previously called `service.status()`
whenever a profile existed, even without a joined session. That reaches the
reserved Minecraft MCP through `MinecraftMcpPort.status()` and `mcp-host.ts`.
The API routes and captain tools expose requested reads; they do not create this
periodic loop.

| State                    | Before                                                    | After                              |
| ------------------------ | --------------------------------------------------------- | ---------------------------------- |
| Idle, configured profile | About 120 status calls/minute, reduced by request latency | 0 periodic MCP status calls/minute |
| Joined, capture running  | 500 ms between completed capture ticks                    | Unchanged                          |
| Confirmed disconnect     | Returns to about 120 idle calls/minute                    | 0 periodic MCP status calls/minute |

Before is code-derived: `60,000 / (500 + request latency in ms)`, consistent
with the reported live 100–115 calls/minute. After is also code-derived: idle
ticks return local null status without calling profiles or the motor. Active
ticks make one status call and a second when validating a captured frame.
Unresolved owned recovery still polls; only confirmed termination releases
ownership. Explicit API/tool status requests remain available while idle.

## Verification

`clankie heavy -- pnpm exec vitest run
apps/clankie/test/minecraft-capture.test.ts
apps/clankie/test/minecraft-driver.integration.test.ts` passed: 2 files, 10 tests.

- Focused lifecycle test: configured idle destination, zero status calls over
  60 seconds of virtual time; join resumes polling within 500 ms; confirmed
  disconnect returns to zero calls over another 60 seconds. This test uses the
  existing controllable port fixture with the real service ledger and extension.
- Real transport proof: actual stdio MCP motor and Mineflayer packet world,
  counted through the MCP host's call logs. Zero status calls during 1.1 seconds
  idle, then at least two during 1.1 seconds active without explicit status reads
  in that measurement window. Optional browser rendering is disabled.

Focused output is retained in the assignment worktree at
`.local/vuh-2213/focused-tests.log`. The integrator retains its exact-tree landing
gate separately in its batch record. No live service restart or deployment was
performed; post-deployment live rates remain for the owner to verify.
