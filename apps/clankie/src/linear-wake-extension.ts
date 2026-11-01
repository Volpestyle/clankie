import type { ClankieExtension } from "@clankie/extension";
import { linearWakeRoutes, type LinearRouteParts } from "./app/linear-routes.ts";
import type { CorePorts, CoreProjection } from "./extension-host.ts";

/** Linear wake's owner switch. The composition root gates its captain wiring at start. */
export function linearWakeExtension(
  parts: LinearRouteParts,
): ClankieExtension<undefined, CorePorts, never, CoreProjection> {
  return {
    contractVersion: 1,
    id: "linear-wake",
    settings: { key: "linearWake", schema: { parse: () => undefined } },
    needs: [],
    create() {
      return {
        async start() {},
        async stop() {},
        health: () => ({ state: "ready" }),
        projection: () => ({ routes: linearWakeRoutes(parts) }),
      };
    },
  };
}
