import type { ClankieExtension } from "@clankie/extension";
import type { CorePorts, CoreProjection } from "./extension-host.ts";

/**
 * Minecraft's owner switch (ADR 0328). Minecraft stays a `GameExtension` in the
 * game registry, which owns its tools, routes, play lease and recovery; this
 * entry only puts the switch beside the others. The composition root reads
 * the switch at start: off, it never registers Minecraft, builds its host or
 * offers its MCP motor. Play health stays in the games catalog
 * (`clankie games`), because a degraded entry here would not come back.
 */
export const minecraftSwitch: ClankieExtension<undefined, CorePorts, never, CoreProjection> = {
  contractVersion: 1,
  id: "minecraft",
  settings: { key: "minecraft", schema: { parse: () => undefined } },
  needs: [],
  create() {
    return {
      async start() {},
      async stop() {},
      health: () => ({ state: "ready" }),
    };
  },
};
