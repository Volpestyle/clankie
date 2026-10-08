# @clankie/minecraft

Minecraft's turn-based play adapter and model prompt over the shared
[`@clankie/play`](../../packages/play/README.md) kernel
([ADR 0253](../../docs/adr/0253-turn-based-games-share-a-play-kernel.md)).

`runMinecraftPlay` supplies native observations, generation and health fences,
bounded action settlement/cancellation, verified effects, memory and idle policy.
`createModelMinecraftPlayMind` supplies the Minecraft prompt and action decoder;
the shared transport streams and prices the provider call. The service retains
persona/provider resolution, grants, driver handoffs, leases and lifecycle.

The motor remains [`minecraft-mcp`](../minecraft-mcp/README.md). This library
neither joins a world nor grants access to one. The existing API, CLI and tools
continue to enter through the service host. Journals use the common identity and
version envelope with native Minecraft evidence, and the existing evaluator,
story and journey readers accept them. Full lifecycle extension registration is
still tracked in VUH-1616.

Boundary checks live in
[`minecraft-play.integration.test.ts`](../../apps/clankie/test/minecraft-play.integration.test.ts);
they use isolated HTTP model/body services, filesystem journals and the real
play-voice transport, without a live world or provider account.
