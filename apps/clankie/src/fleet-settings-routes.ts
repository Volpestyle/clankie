import { createModelRegistry } from "@clankie/model-registry";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  FLEET_HIRE_DEFAULTS_PATH,
  FLEET_SETTINGS_PATH,
  FLEET_SETTINGS_CONTEXT_PATH,
  HIRE_NO_PREFERENCE,
  HireProfileSchema,
  UpdateFleetHireDefaultsSchema,
  type FleetHireDefaultsSnapshot,
  FleetSettingsContextRequestSchema,
  FleetAutonomySchema,
  autonomyLevelFleet,
  matchingAutonomyLevel,
  autonomyDrift,
  UpdateFleetSettingsSchema,
  type FleetSettingsSnapshot,
  type FleetResourcePolicy,
} from "@clankie/protocol";
import type { ClankieSettings, SettingsStore } from "@clankie/settings";
import {
  resolveFleetSettingsContext,
  type FleetSettingsContextDependencies,
} from "./fleet-settings-context.ts";
import { resourceMachine, machineResourcePolicy } from "./machine-fleet-resources.ts";

function fleetSettingsSnapshot(
  settings: ClankieSettings,
  includeWorkPolicy = false,
  includeMaximumTrust = false,
  includeWatch = false,
): FleetSettingsSnapshot {
  const fleet = {
    ...settings.fleet,
    size: settings.fleet.size,
    models: settings.fleet.models,
    ...(settings.fleet.resources === undefined ? {} : { resources: settings.fleet.resources }),
    ...settings.autonomy.fleet,
  };
  const drift = autonomyDrift(settings.autonomy.fleet);
  const covered = includeMaximumTrust ? { fleet, maximumTrustMode: settings.maximumTrustMode } : fleet;
  // Watch changes no leaf, so it joins the revision while on: a client that read Off before
  // another chose Watch gets a conflict, not a silent exit. Off of Watch hashes as before.
  return {
    schemaVersion: 1,
    workingPreferences: true,
    ...(includeWorkPolicy
      ? {
          workPolicy: true,
          ...(settings.retiredWorkingPreferences === undefined
            ? {}
            : { retiredWorkingPreferences: settings.retiredWorkingPreferences }),
        }
      : {}),
    fleetGates: true,
    resourceMachines: ["local", ...settings.machines.map((machine) => machine.id)],
    revision: createHash("sha256")
      .update(JSON.stringify(settings.autonomy.watch === true ? { covered, watch: true } : covered))
      .digest("hex"),
    fleet,
    autonomyLevel: matchingAutonomyLevel(settings.autonomy.fleet),
    ...(settings.autonomy.confirmedAt === undefined
      ? {}
      : { autonomyConfirmedAt: settings.autonomy.confirmedAt }),
    ...(includeMaximumTrust ? { maximumTrustMode: settings.maximumTrustMode } : {}),
    ...(includeWatch ? { watch: settings.autonomy.watch === true } : {}),
    ...(drift === undefined ? {} : { autonomyDrift: drift }),
  };
}
class InvalidHireDefaults extends Error {}
/** Harness, model and effort only; the revision covers the whole stored profile. */
function fleetHireDefaultsSnapshot(settings: ClankieSettings): FleetHireDefaultsSnapshot {
  const hire = settings.fleet.hire ?? {};
  return {
    schemaVersion: 1,
    revision: createHash("sha256").update(JSON.stringify(hire)).digest("hex"),
    hire: {
      ...(hire.harness === undefined ? {} : { harness: hire.harness }),
      ...(hire.model === undefined ? {} : { model: hire.model }),
      ...(hire.effort === undefined ? {} : { effort: hire.effort }),
    },
  };
}
export function createFleetSettingsRoutes(
  authorize: (request: Request) => Promise<true | "authentication_required" | "forbidden">,
  settings: Pick<SettingsStore, "load"> & Partial<Pick<SettingsStore, "update">>,
  dependencies: FleetSettingsContextDependencies & {
    configureResources?: ((policy: FleetResourcePolicy, machine?: string) => Promise<unknown>) | undefined;
  } = {},
): Hono {
  const app = new Hono();
  for (const path of [FLEET_SETTINGS_PATH, FLEET_SETTINGS_CONTEXT_PATH, FLEET_HIRE_DEFAULTS_PATH])
    app.use(path, async (context, next) => {
      context.header("cache-control", "no-store");
      const authority = await authorize(context.req.raw);
      if (authority !== true)
        return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
      await next();
    });
  app.get(FLEET_SETTINGS_PATH, async (context) => {
    const current = await settings.load();
    const authority = await authorize(context.req.raw);
    if (authority !== true) return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
    return context.json(
      fleetSettingsSnapshot(
        current,
        context.req.query("includeWorkPolicy") === "true",
        context.req.query("includeMaximumTrust") === "true",
        context.req.query("includeWatch") === "true",
      ),
    );
  });
  app.post(FLEET_SETTINGS_PATH, bodyLimit({ maxSize: 16 * 1024 }), async (context) => {
    if (!settings.update) return context.json({ error: "settings_unavailable" }, 503);
    const input = UpdateFleetSettingsSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "malformed" }, 400);
    if (
      input.data.changes.maximumTrustMode !== undefined &&
      context.req.query("includeMaximumTrust") !== "true"
    )
      return context.json({ error: "malformed" }, 400);
    let before: string | undefined;
    try {
      const updated = await settings.update(
        (current) => {
          if (
            fleetSettingsSnapshot(current, false, context.req.query("includeMaximumTrust") === "true")
              .revision !== input.data.expectedRevision
          )
            throw new Error("Fleet settings changed");
          before = JSON.stringify(current);
          const {
            size,
            models,
            resources,
            machineResources,
            notes,
            tools,
            peerMessages,
            remoteGates,
            workerSandbox,
            seatHost,
            leadRestarts,
            seatRestarts,
            autoTidy,
            hire,
            autonomyLevel,
            autonomyConfirmed,
            watch,
            maximumTrustMode,
            ...preferences
          } = input.data.changes;
          if (machineResources)
            for (const machine of Object.keys(machineResources)) {
              if (resourceMachine(current, machine) !== machine)
                throw new Error("Use the canonical machine ID");
            }
          const defaults = FleetAutonomySchema.parse({});
          const resolved = Object.fromEntries(
            Object.entries(preferences).map(([field, value]) => [
              field,
              value ?? defaults[field as keyof typeof defaults],
            ]),
          );
          // Watch writes Off's leaves; any level the owner picks leaves it (ADR 0308).
          const watching = watch ?? (autonomyLevel === undefined ? current.autonomy.watch === true : false);
          const level = watch === true ? "off" : autonomyLevel;
          const { watch: _previousWatch, ...autonomy } = current.autonomy;
          return {
            ...current,
            ...(maximumTrustMode === undefined ? {} : { maximumTrustMode }),
            fleet: {
              ...current.fleet,
              ...(size === undefined ? {} : { size }),
              ...(models === undefined ? {} : { models }),
              ...(resources === undefined ? {} : { resources }),
              ...(machineResources === undefined
                ? {}
                : { machineResources: { ...current.fleet.machineResources, ...machineResources } }),
              ...(resources !== undefined && current.fleet.machineResources?.local && !machineResources?.local
                ? {
                    machineResources: {
                      ...current.fleet.machineResources,
                      ...machineResources,
                      local: resources,
                    },
                  }
                : {}),
              ...(notes === undefined ? {} : { notes }),
              ...(tools === undefined ? {} : { tools }),
              ...(peerMessages === undefined ? {} : { peerMessages }),
              ...(remoteGates === undefined ? {} : { remoteGates }),
              ...(workerSandbox === undefined ? {} : { workerSandbox }),
              ...(seatHost === undefined ? {} : { seatHost }),
              ...(leadRestarts === undefined ? {} : { leadRestarts }),
              ...(seatRestarts === undefined ? {} : { seatRestarts }),
              ...(autoTidy === undefined ? {} : { autoTidy }),
              ...(hire === undefined ? {} : { hire: hire ?? undefined }),
            },
            autonomy: {
              ...autonomy,
              // Only an owner's level or Watch choice confirms; a hand-set leaf or a default never does.
              ...(level === undefined && autonomyConfirmed === undefined && watch === undefined
                ? {}
                : { confirmedAt: current.autonomy.confirmedAt ?? new Date().toISOString() }),
              fleet: FleetAutonomySchema.parse({
                ...current.autonomy.fleet,
                ...(level === undefined ? {} : autonomyLevelFleet(level)),
                ...resolved,
              }),
              ...(watching ? { watch: true as const } : {}),
            },
          };
        },
        async () => {
          if ((await authorize(context.req.raw)) !== true) throw new Error("Owner authority changed");
          if (JSON.stringify(await settings.load()) !== before) throw new Error("Settings changed");
        },
      );
      if (input.data.changes.resources !== undefined)
        await dependencies.configureResources?.(machineResourcePolicy(updated, "local"));
      for (const machine of Object.keys(input.data.changes.machineResources ?? {}))
        await dependencies.configureResources?.(machineResourcePolicy(updated, machine), machine);
      return context.json(
        fleetSettingsSnapshot(
          updated,
          context.req.query("includeWorkPolicy") === "true",
          context.req.query("includeMaximumTrust") === "true",
          context.req.query("includeWatch") === "true",
        ),
      );
    } catch {
      return context.json({ error: "fleet_settings_conflict" }, 409);
    }
  });
  app.get(FLEET_HIRE_DEFAULTS_PATH, async (context) => {
    const current = await settings.load();
    const authority = await authorize(context.req.raw);
    if (authority !== true) return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
    const snapshot = fleetHireDefaultsSnapshot(current);
    if (context.req.query("includeModels") !== "true") return context.json(snapshot);
    const catalog = await createModelRegistry().catalog();
    const agents = [
      { id: "claude" as const, label: "Claude", provider: "anthropic" },
      { id: "codex" as const, label: "Codex", provider: "openai" },
    ].map((agent) => ({
      id: agent.id,
      label: agent.label,
      models: Object.values(catalog[agent.provider]?.models ?? {})
        .filter((model) => model.status !== "deprecated" && model.id.length <= 200)
        .filter((model) => model.tool_call && model.modalities?.output.includes("text"))
        .filter((model) =>
          agent.id === "claude"
            ? model.id.startsWith("claude-")
            : model.id.startsWith("gpt-") || /^(o[1-9])/.test(model.id),
        )
        .map((model) => ({ id: model.id, name: model.name }))
        .sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true })),
    }));
    // Registry reads never waive the caller's current authority.
    const authorityAfterCatalog = await authorize(context.req.raw);
    if (authorityAfterCatalog !== true)
      return context.json(
        { error: authorityAfterCatalog },
        authorityAfterCatalog === "forbidden" ? 403 : 401,
      );
    return context.json({ ...snapshot, agents });
  });
  app.post(FLEET_HIRE_DEFAULTS_PATH, bodyLimit({ maxSize: 4 * 1024 }), async (context) => {
    if (!settings.update) return context.json({ error: "settings_unavailable" }, 503);
    const input = UpdateFleetHireDefaultsSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "malformed" }, 400);
    let before: string | undefined;
    try {
      const updated = await settings.update(
        (current) => {
          if (fleetHireDefaultsSnapshot(current).revision !== input.data.expectedRevision)
            throw new Error("Hire defaults changed");
          before = JSON.stringify(current);
          // `auto` is no preference: the field is cleared, never stored (ea54ebd6).
          const next: Record<string, unknown> = { ...current.fleet.hire };
          delete next.effort; // Preserved in the read-only retirement receipt, never a new default.
          for (const [field, value] of Object.entries(input.data.changes)) {
            if (value === undefined) continue;
            if (value === HIRE_NO_PREFERENCE) delete next[field];
            else next[field] = value;
          }
          const parsedHire = HireProfileSchema.safeParse(next);
          if (!parsedHire.success) throw new InvalidHireDefaults();
          const hire = parsedHire.data;
          const fleet = { ...current.fleet };
          if (Object.keys(hire).length) fleet.hire = hire;
          else delete fleet.hire;
          return { ...current, fleet };
        },
        async () => {
          if ((await authorize(context.req.raw)) !== true) throw new Error("Owner authority changed");
          if (JSON.stringify(await settings.load()) !== before) throw new Error("Settings changed");
        },
      );
      return context.json(fleetHireDefaultsSnapshot(updated));
    } catch (error) {
      if (error instanceof InvalidHireDefaults) return context.json({ error: "malformed" }, 400);
      return context.json({ error: "fleet_settings_conflict" }, 409);
    }
  });
  app.get(FLEET_SETTINGS_CONTEXT_PATH, async (context) => {
    const input = FleetSettingsContextRequestSchema.safeParse(context.req.query());
    if (!input.success) return context.json({ error: "invalid_fleet_settings_context" }, 400);
    try {
      const current = await settings.load();
      const result = await resolveFleetSettingsContext(current, input.data, dependencies);
      if (JSON.stringify(await settings.load()) !== JSON.stringify(current))
        throw new Error("Settings changed");
      const authority = await authorize(context.req.raw);
      if (authority !== true)
        return context.json({ error: authority }, authority === "forbidden" ? 403 : 401);
      return context.json(result);
    } catch (error) {
      return context.json(
        {
          error: "fleet_settings_context_unavailable",
          detail: error instanceof Error ? error.message : "Context unavailable",
        },
        409,
      );
    }
  });
  return app;
}
