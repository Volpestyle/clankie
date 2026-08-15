# apps/gba-mcp

Clankie's GBA body published as an MCP
server, so any harness that speaks the
protocol (Claude Code, Codex, ...) can play
his FireRed over stdio. It is a consumer of
the existing emulator tool surface — every
action goes through the same
`EnvironmentRuntime` seam, lease, and
fail-closed limits as Clankie's own
free-play loop.

## Children

- `README.md` — operating guide: tools,
  possession, checkpoints, Discord ports.
- `package.json` — `@clankie/gba-mcp`;
  `start` (stdio), `probe` scripts.
- `scripts/` — `probe.ts`, drives the live
  server like an external harness.
- `src/` — server, tools, possession lease
  and log, speech/hearing ports, entrypoint.
- `test/` — vitest suites per src module.
- `tsconfig.json` — noEmit typecheck config.

## Architecture

One mind drives the body at a time:
gameplay tools require a revocable
possession lease (`gba_emulator_possess`),
deny-by-default via
`CLANKIE_GBA_POSSESSION_HOLDERS`; observing
never needs it. A separate `body.lock`
(taken on possession, not at startup)
decides which process owns the body, so
many servers can coexist and look while one
drives. Lease transitions log to stderr and
append durably to `possession-events.jsonl`.

Frames publish best-effort to the activity
surface so people can watch; `clankie_say`
and `clankie_listen` extend possession into
Discord through deny-by-default ports the
bridge implements — the possessor reports
events, the persona composes the words.
ROM-gated like free play: without
`CLANKIE_GBA_ROM_PATH` it runs a labeled
deterministic double.
