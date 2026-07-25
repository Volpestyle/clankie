# Clankie's GBA body, as an MCP server

Publishes the emulator surface over MCP so any harness — Claude Code, Codex,
anything that speaks the protocol — can play Clankie's FireRed.

This is also the strongest test of the tool surface itself: if an external
harness plays well through these tools, Clankie's own loop can.

## Not a second body

Three things make this a _consumer_ of the existing surface rather than a
parallel stack:

- Tool names and arguments derive from `GbaEmulatorToolNameSchema` and the
  action/observation schemas in `@clankie/interactive-environment`. Nothing here
  invents a capability.
- Every action dispatches through `EnvironmentRuntime`, so a possessor is bound
  by the same lease, idempotency, and fail-closed limits a script is. This is
  what keeps [ADR 0049](../../docs/adr/0049-free-play-agency-and-non-deterministic-evidence.md)'s
  "changes who decides, not how an action is authorised" true when the decider
  is an external harness.
- The ROM/scenario loader is shared with the free-play CLI, so there is one path
  to the core and one place digests are checked.

`@clankie/mcp-registry` is the _consumption_ side — Clankie's workers using
external servers under doctrine. This is the opposite direction and is
deliberately a separate package.

## Running it

```bash
pnpm --filter @clankie/gba-mcp start          # stdio
pnpm --filter @clankie/gba-mcp probe          # drive it like a harness
```

ROM-gated exactly like free play: with `CLANKIE_GBA_ROM_PATH` and
`CLANKIE_GBA_SAVESTATE_PATH` this is the real game behind the pinned core;
without them it is the clearly-labeled deterministic double.

`stdout` is the transport, so the server logs readiness to `stderr` only.

## Tools

| Tool                        | What it does                                                            |
| --------------------------- | ----------------------------------------------------------------------- |
| `gba_emulator_observe`      | Decoded state **and the rendered screen as an image**                   |
| `gba_emulator_start_action` | One catalogued action; a short tap only turns, 16 frames commits a step |
| `gba_emulator_pause`        | Stop for a stated reason when the state looks uncertain                 |

Observation returns the frame because the decoded state is a privileged, partial
view: it carries position and facing but not what is _in_ the room. A caller that
reads only RAM discovers furniture by walking into it.

## Fail-closed, at two layers

Verified by `probe`:

```
refusal:          MCP error -32602: Input validation error …   (protocol schema)
emulator refusal: invalid_action: frames                        (catalogue bound)
```

An uncatalogued button never reaches the core, and a frame count past the
session bound is refused with its reason rather than clamped.

## Not yet

Possession is not implemented. `GbaToolContext.assertMayAct` is the hook: when a
lease exists, gameplay tools will refuse without it while observation stays open.
Until then the server assumes it is the only driver — do not run it against a
session the free-play loop is also driving.
