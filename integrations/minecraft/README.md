# @clankie/minecraft

Minecraft's turn-based play adapter and model prompt over the shared
[`@clankie/play`](../../packages/play/README.md) kernel
([ADR 0254](../../docs/adr/0254-turn-based-games-share-a-play-kernel.md)).

`runMinecraftPlay` supplies native observations, generation and health fences,
bounded action settlement/cancellation, verified effects, memory and idle policy.
`createModelMinecraftPlayMind` supplies the Minecraft prompt and action decoder;
the shared transport streams and prices the provider call. Core retains
persona/provider resolution, grants, destination policy and the durable play ledger.

The motor remains [`minecraft-mcp`](../minecraft-mcp/README.md). `minecraftExtension.create(host)` owns the connector state machine,
continuous play host, capture and optional event wake projection. The approved
host supplies its private MCP call port, conversation guards, durable lease
ledger, model resolution and publishing sink. Creating the factory never joins
a world or activates capture; `activate()` starts idle polling, and
`deactivate()` quiesces polling/capture/mind without claiming the connector ended.
Native joins and the typed `start` both use the same service/session record.
Domain tools and API routes live here; `minecraftProjection` binds them to the
host authorizer and removes them with an idle registration. Stale native entry
references retain the registry's final fence. The existing API, CLI and TUI
continue to use the same settings and commands. Journals use the common identity and
version envelope with native Minecraft evidence, and the existing evaluator,
story and journey readers accept them. Owner-authenticated discovery is `clankie games extensions` or TUI
`/games extensions`; health is local lifecycle state, not live-body proof.

Boundary checks live in
[`minecraft-play.integration.test.ts`](../../apps/clankie/test/minecraft-play.integration.test.ts);
they use isolated HTTP model/body services, filesystem journals and the real
play-voice transport, without a live world or provider account.
