import type { ClankieExtension } from "@clankie/extension";
import { activityRoutes, type ActivityRouteParts } from "../activity-routes.ts";
import type { CorePorts, CoreProjection } from "../extension-host.ts";

/**
 * World as an ADR 0328 extension. It starts with the Activity's admission and
 * sharing routes; its sharing and PokeAgent play tools reach the captain only
 * when it is on at start. Play sessions, the hosted world and the watch
 * surface are still built by the composition root and move here next.
 */
export function worldExtension(
  parts: ActivityRouteParts,
): ClankieExtension<undefined, CorePorts, never, CoreProjection> {
  return {
    contractVersion: 1,
    id: "world",
    settings: { key: "world", schema: { parse: () => undefined } },
    needs: [],
    create() {
      const routes = activityRoutes(parts);
      return {
        async start() {},
        async stop() {},
        health: () => ({ state: "ready" }),
        projection: () => ({ routes }),
      };
    },
  };
}
