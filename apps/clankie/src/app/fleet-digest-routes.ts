import type { Hono } from "hono";
import { FleetCapacitySchema } from "@clankie/protocol";
import { FLEET_DIGEST_PATH } from "@clankie/protocol/fleet-digest";
import { collectLeadChanges } from "../lead-change-read.ts";
import { projectFleetDigest } from "../fleet-digest.ts";
import { authenticateOperator } from "./http-auth.ts";
import type { ClankieAppDependencies } from "./types.ts";

export function registerFleetDigestRoutes(
  app: Hono,
  dependencies: ClankieAppDependencies,
  options: {
    herdr(): boolean;
  },
) {
  app.get(FLEET_DIGEST_PATH, async (context) => {
    if (new URL(context.req.url).search) return context.json({ error: "invalid_fleet_digest_request" }, 400);
    let authentication: { assertCurrent(): void } | undefined;
    try {
      authentication = dependencies.authenticateOperator?.readFence?.(context.req.raw);
    } catch {
      /* Unavailable witnesses refuse below. */
    }
    const identity = await authenticateOperator(context.req.raw, dependencies);
    if (identity === "unavailable")
      return context.json({ error: "operator_authentication_unavailable" }, 503);
    if (!identity) return context.json({ error: "operator_authentication_required" }, 401);
    try {
      if (!authentication) return context.json({ error: "fleet_digest_unavailable" }, 503);
      const work = dependencies.workItems;
      const scope = await work?.leadChangeScope();
      const herdr = options.herdr();
      const captain = dependencies.captain;
      const fleet = herdr
        ? captain
            .serveOperatorConversation({ op: "fleet", schemaVersion: 1, includeClosedPanes: true })
            .then((result) => (result.op === "fleet" ? result : undefined))
        : Promise.resolve(undefined);
      const [changes, capacity, snapshot] = await Promise.allSettled([
        collectLeadChanges({
          captain,
          herdr,
          fleet,
          ...(work ? { work } : {}),
          signal: context.req.raw.signal,
        }),
        captain.serveOperatorConversation({
          op: "fleet_capacity",
          schemaVersion: 1,
          includeMachineResources: true,
        }),
        fleet,
      ]);
      const reading =
        capacity.status === "fulfilled" && capacity.value.op === "fleet_capacity"
          ? FleetCapacitySchema.safeParse(capacity.value.result)
          : undefined;
      const result = projectFleetDigest({
        now: (dependencies.clock ?? (() => new Date()))(),
        changes: changes.status === "fulfilled" ? changes.value : [],
        capacity: reading?.success ? reading.data : undefined,
        fleet: snapshot.status === "fulfilled" ? snapshot.value?.snapshot : undefined,
      });
      const publication = await work?.prepareLeadChangeScope();
      const fresh = await authenticateOperator(context.req.raw, dependencies);
      if (!fresh || fresh === "unavailable" || fresh.operatorId !== identity.operatorId)
        return context.json({ error: "operator_authentication_required" }, 401);
      // No await after the combined authentication, repository and discovery fence.
      publication?.assertCurrent();
      authentication.assertCurrent();
      if (publication?.stamp !== scope || options.herdr() !== herdr || context.req.raw.signal.aborted)
        return context.json({ error: "fleet_digest_unavailable" }, 503);
      return context.json(result, 200, { "cache-control": "no-store" });
    } catch {
      return context.json({ error: "fleet_digest_unavailable" }, 503);
    }
  });
}
