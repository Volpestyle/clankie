import type { ClankieExtension } from "@clankie/extension";
import { linearRoutes, type LinearRouteParts } from "./app/linear-routes.ts";
import type { CorePorts, CoreProjection } from "./extension-host.ts";

/**
 * Linear as an ADR 0328 extension. It starts with its webhook, wake and
 * settings routes; the client, request budget and mirrors are still built by
 * the composition root, which hands them in, and move here next. Switched off,
 * Linear's routes are not mounted and the rest of the fleet runs as before.
 */
export function linearTrackerExtension(
  parts: LinearRouteParts,
): ClankieExtension<undefined, CorePorts, never, CoreProjection> {
  return {
    contractVersion: 1,
    id: "tracker-linear",
    settings: { key: "trackerLinear", schema: { parse: () => undefined } },
    needs: [],
    create() {
      const routes = linearRoutes(parts);
      return {
        async start() {},
        async stop() {},
        health: () => ({ state: "ready" }),
        projection: () => ({ routes }),
      };
    },
  };
}
