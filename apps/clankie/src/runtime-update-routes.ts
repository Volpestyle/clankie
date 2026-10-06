import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { realpath } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import type { RuntimeUpdater, UpdateAuthority } from "../../tui/bin/runtime-updater.ts";
import { HoldOverrideSchema } from "@clankie/protocol/integrate";
import type { DeployHolds } from "./deploy-holds.ts";
import { FleetHarnessRefreshRequestSchema } from "@clankie/protocol/fleet-settings";
import {
  FLEET_WORKER_CATALOG_REFRESH_PATH,
  FLEET_WORKER_TOOL_RESTART_PATH,
  FleetWorkerToolRestartRequestSchema,
  FleetWorkerToolRestartResultSchema,
  FleetWorkerCatalogRefreshRequestSchema,
  FleetWorkerCatalogRefreshResultSchema,
} from "@clankie/protocol/tool-catalog";
import type { RefreshWorkerCatalogs } from "./worker-tool-refresh.ts";
import type { SettingsStore } from "@clankie/settings";
import { RuntimeCanaryPolicySchema, type RuntimeCanary } from "./runtime-canary.ts";
import type { HerdrFleet } from "./herdr-fleet.ts";
import {
  resolveFleetSettingsContext,
  type FleetSettingsContextDependencies,
} from "./fleet-settings-context.ts";

export interface HarnessRefreshAuthority {
  readonly authorizeSetup: (machine: string, fleet?: HerdrFleet) => Promise<void>;
}
class HarnessRefreshPolicyError extends Error {
  public readonly code: "machine_setup_owner_approval_required" | "machine_setup_link_required";
  public constructor(code: "machine_setup_owner_approval_required" | "machine_setup_link_required") {
    super(code);
    this.code = code;
  }
}

class CanaryPolicyAuthorityError extends Error {}

export function createRuntimeUpdateRoutes(options: {
  readonly updater?: RuntimeUpdater | undefined;
  readonly canary?: RuntimeCanary | undefined;
  readonly holds?: DeployHolds | undefined;
  readonly refreshHarnesses?: ((authority: HarnessRefreshAuthority) => Promise<unknown>) | undefined;
  readonly settings?: Pick<SettingsStore, "load"> | undefined;
  readonly setup?: FleetSettingsContextDependencies | undefined;
  readonly pluginVersionInstalled?: ((version: string) => void) | undefined;
  readonly refreshWorkerCatalogs?: RefreshWorkerCatalogs | undefined;
  readonly restartWorkerTools?: import("./captain/port.ts").CaptainPort["restartWorkerTools"] | undefined;
  readonly authorize: (request: Request) => Promise<UpdateAuthority | undefined>;
}): Hono {
  const app = new Hono();
  app.use("/v1/runtime-update/canary", bodyLimit({ maxSize: 1024 }));
  app.get("/v1/runtime-update/canary", async (context) => {
    const authority = await options.authorize(context.req.raw);
    if (!authority) return context.json({ error: "operator_required" }, 403);
    if (!options.canary) return context.json({ error: "runtime_canary_unavailable" }, 503);
    try {
      await authority.guard();
    } catch {
      return context.json({ error: "operator_revoked" }, 403);
    }
    if (!authority.current()) return context.json({ error: "operator_revoked" }, 403);
    return context.json({ policy: options.canary.policy(), canary: options.canary.status() ?? null }, 200, {
      "Cache-Control": "no-store",
    });
  });
  app.put("/v1/runtime-update/canary", async (context) => {
    const authority = await options.authorize(context.req.raw);
    if (!authority) return context.json({ error: "operator_required" }, 403);
    if (!options.canary) return context.json({ error: "runtime_canary_unavailable" }, 503);
    const parsed = z
      .strictObject({
        windowMs: RuntimeCanaryPolicySchema.shape.windowMs.removeDefault().optional(),
        sampleIntervalMs: RuntimeCanaryPolicySchema.shape.sampleIntervalMs.removeDefault().optional(),
        cpuPercent: RuntimeCanaryPolicySchema.shape.cpuPercent.removeDefault().optional(),
        healthLatencyMs: RuntimeCanaryPolicySchema.shape.healthLatencyMs.removeDefault().optional(),
      })
      .safeParse(await context.req.json().catch(() => undefined));
    if (!parsed.success) return context.json({ error: "invalid_canary_policy" }, 400);
    try {
      await authority.guard();
    } catch {
      return context.json({ error: "operator_revoked" }, 403);
    }
    if (!authority.current()) return context.json({ error: "operator_revoked" }, 403);
    let policy;
    try {
      policy = await options.canary.configure(parsed.data, async () => {
        try {
          await authority.guard();
        } catch {
          throw new CanaryPolicyAuthorityError("Operator authority changed");
        }
        if (!authority.current()) throw new CanaryPolicyAuthorityError("Operator authority changed");
      });
    } catch (error) {
      if (error instanceof CanaryPolicyAuthorityError)
        return context.json({ error: "operator_revoked" }, 403);
      if (error instanceof z.ZodError) return context.json({ error: "invalid_canary_policy" }, 400);
      throw error;
    }
    return context.json({ policy, appliesTo: "next_canary" }, 200, { "Cache-Control": "no-store" });
  });
  app.post(FLEET_WORKER_TOOL_RESTART_PATH, bodyLimit({ maxSize: 8192 }), async (context) => {
    const authority = await options.authorize(context.req.raw);
    if (!authority) return context.json({ error: "operator_required" }, 403);
    const input = FleetWorkerToolRestartRequestSchema.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!input.success) return context.json({ error: "invalid_worker_tool_restart" }, 400);
    if (!options.restartWorkerTools) return context.json({ error: "worker_tool_restart_unavailable" }, 503);
    context.header("Cache-Control", "no-store");
    try {
      await authority.guard();
      if (!authority.current()) return context.json({ error: "operator_revoked" }, 403);
      return context.json(
        FleetWorkerToolRestartResultSchema.parse(await options.restartWorkerTools(input.data, authority)),
      );
    } catch {
      return context.json({ error: "worker_tool_restart_failed" }, 503);
    }
  });
  app.post(FLEET_WORKER_CATALOG_REFRESH_PATH, bodyLimit({ maxSize: 1024 }), async (context) => {
    const authority = await options.authorize(context.req.raw);
    if (!authority) return context.json({ error: "operator_required" }, 403);
    const input = FleetWorkerCatalogRefreshRequestSchema.safeParse(
      await context.req.json().catch(() => undefined),
    );
    if (!input.success) return context.json({ error: "invalid_worker_catalog_refresh" }, 400);
    if (!options.refreshWorkerCatalogs)
      return context.json({ error: "worker_catalog_refresh_unavailable" }, 503);
    context.header("Cache-Control", "no-store");
    try {
      await authority.guard();
      if (!authority.current()) return context.json({ error: "operator_revoked" }, 403);
      const result = await options.refreshWorkerCatalogs(
        {
          ...(input.data.paneId === undefined ? {} : { paneId: input.data.paneId }),
          ...(input.data.restart === undefined ? {} : { restart: input.data.restart }),
        },
        authority,
      );
      await authority.guard();
      if (!authority.current()) return context.json({ error: "operator_revoked" }, 403);
      return context.json(FleetWorkerCatalogRefreshResultSchema.parse(result));
    } catch {
      return context.json(
        { error: authority.current() ? "worker_catalog_refresh_failed" : "operator_revoked" },
        authority.current() ? 409 : 403,
      );
    }
  });
  app.post("/v1/harness-plugin-version", bodyLimit({ maxSize: 1024 }), async (context) => {
    const authority = await options.authorize(context.req.raw);
    if (!authority) return context.json({ error: "operator_required" }, 403);
    const input = z
      .object({ version: z.string().regex(/^\d+\.\d+\.\d+$/u) })
      .strict()
      .safeParse(await context.req.json().catch(() => undefined));
    if (!input.success) return context.json({ error: "invalid_plugin_version" }, 400);
    if (!options.pluginVersionInstalled) return context.json({ error: "plugin_notices_unavailable" }, 503);
    await authority.guard();
    if (!authority.current()) return context.json({ error: "operator_revoked" }, 403);
    options.pluginVersionInstalled(input.data.version);
    return context.json({ ok: true, appliesTo: "next_native_client_request" });
  });
  app.post("/v1/harness-refresh", bodyLimit({ maxSize: 16 * 1024 }), async (context) => {
    const authority = await options.authorize(context.req.raw);
    if (!authority) return context.json({ error: "operator_required" }, 403);
    if (!options.refreshHarnesses) return context.json({ error: "harness_refresh_unavailable" }, 503);
    const input = FleetHarnessRefreshRequestSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!input.success) return context.json({ error: "invalid_harness_refresh" }, 400);
    if (!options.settings) return context.json({ error: "harness_refresh_context_unavailable" }, 503);
    context.header("Cache-Control", "no-store");
    let source: { workingDirectory: string; projectId?: string } | undefined;
    const authorizeSetup = async (machine: string, fleet?: HerdrFleet) => {
      await authority.guard();
      if (!authority.current()) throw new Error("Operator authority changed");
      const cwd = await realpath(input.data.workingDirectory);
      if (source && source.workingDirectory !== cwd) throw new Error("Machine setup workspace changed");
      const current = await options.settings!.load();
      if (machine !== "local" && !fleet) throw new Error("Machine setup target proof is required");
      if (fleet) {
        const configured = current.execution.connections.find((entry) => entry.id === machine);
        if (
          !configured ||
          !configured.enabled ||
          fleet.id !== machine ||
          configured.session !== fleet.session ||
          !isDeepStrictEqual(configured.ssh, fleet.ssh)
        )
          throw new Error("Machine setup target changed");
      }
      const policy = await resolveFleetSettingsContext(
        current,
        {
          workingDirectory: input.data.workingDirectory,
          machine,
          ...(input.data.projectId === undefined ? {} : { projectId: input.data.projectId }),
        },
        options.setup ?? {},
      );
      if (source && source.projectId !== policy.projectId) throw new Error("Machine setup project changed");
      source ??= {
        workingDirectory: cwd,
        ...(policy.projectId === undefined ? {} : { projectId: policy.projectId }),
      };
      if (!input.data.ownerApproved && policy.effective.machineSetup === "owner")
        throw new HarnessRefreshPolicyError("machine_setup_owner_approval_required");
      if (!input.data.ownerApproved && !policy.machine.linked)
        throw new HarnessRefreshPolicyError("machine_setup_link_required");
      if (JSON.stringify(await options.settings!.load()) !== JSON.stringify(current))
        throw new Error("Machine setup settings changed");
      await authority.guard();
      if (!authority.current()) throw new Error("Operator authority changed");
      if ((await realpath(input.data.workingDirectory)) !== cwd)
        throw new Error("Machine setup workspace changed");
    };
    try {
      await authorizeSetup("local");
      const receipt = z
        .record(z.string(), z.unknown())
        .parse(await options.refreshHarnesses({ authorizeSetup }));
      return context.json({
        ...receipt,
        ownerApproval: input.data.ownerApproved ? "claimed" : "not_claimed",
      });
    } catch (error) {
      if (!authority.current()) return context.json({ error: "operator_revoked" }, 403);
      if (error instanceof HarnessRefreshPolicyError) return context.json({ error: error.code }, 403);
      return context.json(
        {
          error: "harness_refresh_refused",
          detail: error instanceof Error ? error.message : "Refresh unavailable",
        },
        409,
      );
    }
  });
  app.use("/v1/runtime-update", bodyLimit({ maxSize: 16 * 1024 }));
  app.get("/v1/runtime-update", async (context) => {
    const authority = await options.authorize(context.req.raw);
    if (!authority) return context.json({ error: "operator_required" }, 403);
    if (!options.updater) return context.json({ error: "runtime_updates_unavailable" }, 503);
    try {
      await authority.guard();
    } catch {
      return context.json({ error: "operator_revoked" }, 403);
    }
    if (!authority.current()) return context.json({ error: "operator_revoked" }, 403);
    context.header("Cache-Control", "no-store");
    try {
      const result = options.updater.status();
      const holds = options.holds ? await options.holds.list() : undefined;
      await authority.guard();
      if (!authority.current()) return context.json({ error: "operator_revoked" }, 403);
      return context.json({
        ...result,
        ...(holds === undefined ? {} : { holds }),
        ...(options.canary ? { canaryPolicy: options.canary.policy() } : {}),
      });
    } catch {
      return context.json(
        {
          error: authority.current() ? "update_status_unavailable" : "operator_revoked",
          needsReconciliation: true,
        },
        authority.current() ? 503 : 403,
      );
    }
  });
  app.post("/v1/runtime-update", async (context) => {
    const authority = await options.authorize(context.req.raw);
    if (!authority) return context.json({ error: "operator_required" }, 403);
    if (!options.updater) return context.json({ error: "runtime_updates_unavailable" }, 503);
    const parsed = z
      .object({
        ref: z.string().min(1).max(256).optional(),
        overrides: z.array(HoldOverrideSchema).max(32).default([]),
      })
      .strict()
      .safeParse(await context.req.json().catch(() => undefined));
    if (!parsed.success) return context.json({ error: "invalid_update_request" }, 400);
    try {
      const deploy = async () => {
        await authority.guard();
        return options.updater!.request(parsed.data.ref ?? "main", authority);
      };
      if (!options.holds && parsed.data.overrides.length) throw Error("Deploy holds unavailable");
      const result = options.holds
        ? await options.holds.landing(
            `runtime-update:${parsed.data.ref ?? "main"}`,
            parsed.data.overrides,
            deploy,
          )
        : await deploy();
      return context.json(result, result.accepted ? 202 : 409);
    } catch (error) {
      return context.json(
        { error: authority.current() ? "update_refused" : "operator_revoked", detail: String(error) },
        authority.current() ? 409 : 403,
      );
    }
  });
  return app;
}
