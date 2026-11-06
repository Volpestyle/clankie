import type { Hono } from "hono";
import type { Context } from "hono";
import { FleetCapacitySchema } from "@clankie/protocol";
import {
  FLEET_DAILY_DIGEST_PATH,
  FLEET_DIGEST_PATH,
  FleetDailyDigestReadSchema,
} from "@clankie/protocol/fleet-digest";
import { collectLeadChanges } from "../lead-change-read.ts";
import { projectFleetDigest, type FleetDigestInputs } from "../fleet-digest.ts";
import {
  hostTimeZone,
  projectDailyFleetDigest,
  startDailyFleetDigests,
  type DailyFleetDigests,
} from "../fleet-daily-digest.ts";
import { authenticateOperator } from "./http-auth.ts";
import { logger } from "./log.ts";
import type { ClankieAppDependencies } from "./types.ts";

export function registerFleetDigestRoutes(
  app: Hono,
  dependencies: ClankieAppDependencies,
  options: {
    herdr(): boolean;
  },
): DailyFleetDigests | undefined {
  const clock = dependencies.clock ?? (() => new Date());
  const observe = async (herdr: boolean, signal?: AbortSignal): Promise<FleetDigestInputs> => {
    const work = dependencies.workItems;
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
        ...(signal ? { signal } : {}),
      }),
      // Capacity also refreshes native seats, so discovery-off must skip this source.
      herdr
        ? captain.serveOperatorConversation({
            op: "fleet_capacity",
            schemaVersion: 1,
            includeMachineResources: true,
          })
        : Promise.resolve(undefined),
      fleet,
    ]);
    const reading =
      capacity.status === "fulfilled" && capacity.value?.op === "fleet_capacity"
        ? FleetCapacitySchema.safeParse(capacity.value.result)
        : undefined;
    return {
      changes: changes.status === "fulfilled" ? changes.value : [],
      capacity: reading?.success ? reading.data : undefined,
      fleet: snapshot.status === "fulfilled" ? snapshot.value?.snapshot : undefined,
    };
  };

  /** Every owner digest read shares this authentication and publication fence. */
  const ownerRead = async <T>(
    context: Context,
    project: (observed: FleetDigestInputs, now: Date) => Promise<T> | T,
  ) => {
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
      const result = await project(await observe(herdr, context.req.raw.signal), clock());
      const publication = await work?.prepareLeadChangeScope();
      const fresh = await authenticateOperator(context.req.raw, dependencies);
      if (!fresh || fresh === "unavailable" || fresh.operatorId !== identity.operatorId)
        return context.json({ error: "operator_authentication_required" }, 401);
      // No await after the combined authentication, repository and discovery fence.
      publication?.assertCurrent();
      authentication.assertCurrent();
      if (publication?.stamp !== scope || options.herdr() !== herdr || context.req.raw.signal.aborted)
        return context.json({ error: "fleet_digest_unavailable" }, 503);
      return context.json(result as object, 200, { "cache-control": "no-store" });
    } catch {
      return context.json({ error: "fleet_digest_unavailable" }, 503);
    }
  };

  app.get(FLEET_DIGEST_PATH, (context) =>
    ownerRead(context, (observed, now) => projectFleetDigest({ ...observed, now })),
  );

  const schedule = dependencies.fleetDailyDigest;
  const settings = dependencies.settings;
  const daily =
    schedule && settings
      ? startDailyFleetDigests({
          path: schedule.path,
          settings: () => settings.load(),
          clock,
          ...(schedule.intervalMs === undefined ? {} : { intervalMs: schedule.intervalMs }),
          logger,
          generate: async ({ now, since, slot, timeZone }) => {
            const [observed, github] = await Promise.all([
              observe(options.herdr()),
              (dependencies.workItems?.fleetGithubActivity(since, now) ?? Promise.resolve(undefined)).catch(
                (error: unknown) => {
                  logger.warn({ error: String(error) }, "Daily fleet digest could not read GitHub");
                  return undefined;
                },
              ),
            ]);
            return projectDailyFleetDigest({
              now,
              since,
              slot,
              timeZone,
              observed,
              github,
              hireTimes: dependencies.captain.confirmedHireTimes?.(),
            });
          },
        })
      : undefined;

  app.get(FLEET_DAILY_DIGEST_PATH, async (context) => {
    if (!daily || !settings) return context.json({ error: "fleet_digest_unavailable" }, 503);
    return ownerRead(context, async (observed, now) =>
      FleetDailyDigestReadSchema.parse({
        schemaVersion: 1,
        schedule: { time: (await settings.load()).fleet.digestTime, timeZone: hostTimeZone() },
        waits: {
          observedAt: now.toISOString(),
          attention: projectFleetDigest({ ...observed, now }).attention,
        },
        digest: await daily.latest(),
      }),
    );
  });
  return daily;
}
