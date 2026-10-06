# @clankie/pokemon

Pokémon's implementation of the
[game-extension contract](../../packages/game-extension/README.md). It joins
Clankie's own PokeAgents seat using the broker and the pinned native player
client; no emulator or world host is bundled.

`pokemonExtension` declares the native connector, shipped `pokeagents` skill,
existing `gameplay` settings schema, and `gba_emulator` Activity surface.
`create(host)` returns its guarded lifecycle. The host supplies the resolved
mind/persona, approved Activity and voice clients, evidence projections,
notable-event delivery and private session persistence. Omitting media ports
runs silently without publishing. The extension neither acquires the play lease
nor picks a Discord destination.

- `src/world` owns the connector, semantic mapping, world-operation partition,
  media source and live session operations.
- `src/execution.ts` composes the existing `@clankie/play` mind/journal with the
  body and injected host ports.
- `src/extension.ts` supplies the metadata and lifecycle. Its settings use
  the existing API, `clankie games`, `clankie play` and TUI `/games`; there is
  no second settings store.

The service's old `world/*` paths re-export this package. Its
`createWorldPlayExecution` entry point composes core identity and brokered sinks,
then calls this extension's `start`. External connectors are not rewritten.

For source checks and offline fixtures, from the repository root:

```sh
pnpm --filter @clankie/pokemon typecheck
pnpm exec vitest run --config vitest.config.ts integrations/pokemon/test/extension.integration.test.ts
```

The test uses real file-broker and player-client IPC against an isolated wire
fixture, with a deterministic metered mind. It never joins a live world or calls
a paid provider. The FireRed observation specimen preserves the existing
`apps/clankie/test/world-body.test.ts` fixture shape; the new assertions cover
composition and authority/accounting boundaries rather than gameplay skill.
