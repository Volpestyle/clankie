import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { MinecraftHostCommandSchema, MinecraftCommandSchema, type MinecraftCommand } from "@clankie/protocol";
import { MinecraftSettingsSchema, type SettingsStore } from "@clankie/settings";
import type { MinecraftIdentity as BodyConversationIdentity } from "./authority.ts";
import type { MinecraftHostToolPort as MinecraftHostService } from "./host-tools.ts";
import { MinecraftServiceError, type MinecraftService } from "./service.ts";

export interface MinecraftRouteOptions {
  readonly service?: MinecraftService;
  readonly host?: MinecraftHostService;
  readonly settings?: Pick<SettingsStore, "load"> & Partial<Pick<SettingsStore, "update">>;
  /** Operator authentication is required even for reads; this must never accept a social grant. */
  readonly authorize: (request: Request) => Promise<BodyConversationIdentity | undefined>;
}

async function admitted(identity: BodyConversationIdentity | undefined): Promise<boolean> {
  return (
    identity !== undefined &&
    identity.current() &&
    (await identity.authorize("play", "effect").catch(() => false)) &&
    identity.current()
  );
}

async function dispatch(
  service: MinecraftService,
  command: MinecraftCommand,
  identity: BodyConversationIdentity,
): Promise<unknown> {
  switch (command.action) {
    case "driver":
      return command.driver === undefined
        ? service.driverStatus(identity)
        : service.setDriver(command.driver, identity);
    case "status":
      return service.status(identity);
    case "profiles":
      return { profiles: await service.profiles() };
    case "join":
      return service.join(command.profileId, identity);
    case "observe":
      return service.observe(identity);
    case "act":
      return service.act(command.request, identity, command.actionId);
    case "action_status":
      return { action: await service.actionStatus(command.actionId, identity) };
    case "pause":
      return service.pause(identity);
    case "resume":
      return service.resume(identity);
    case "cancel":
      return service.cancel(command.actionId, identity);
    case "leave":
      return service.leave(identity);
  }
}

export function createMinecraftRoutes(options: MinecraftRouteOptions): Hono {
  const app = new Hono();
  app.use("/v1/minecraft/*", bodyLimit({ maxSize: 32_768 }));
  app.use("/v1/minecraft", bodyLimit({ maxSize: 32_768 }));
  app.post("/v1/minecraft/host", async (context) => {
    const identity = await options.authorize(context.req.raw);
    if (!(await admitted(identity))) return context.json({ error: "operator_required" }, 403);
    const parsed = MinecraftHostCommandSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!parsed.success) return context.json({ error: "invalid_minecraft_host_command" }, 400);
    if (!options.host) return context.json({ error: "minecraft_host_unavailable" }, 503);
    const input = parsed.data;
    let result: unknown;
    switch (input.action) {
      case "configuration":
        result = await options.host.configuration(identity);
        break;
      case "configure":
        result = await options.host.configure(input.settings, identity);
        break;
      case "status":
        result = await options.host.status(identity);
        break;
      case "start":
      case "stop":
      case "restart":
        result = await options.host.lifecycle(input.action, identity);
        break;
      case "backup":
        result = await options.host.backup(identity);
        break;
      case "admin":
        result = await options.host.admin(input.command, identity);
        break;
      case "claim":
        result = await options.host.claim(identity);
        break;
      case "claim_status":
        result = await options.host.claimStatus(identity);
        break;
      case "claim_complete":
        result = await options.host.completeClaim(identity);
        break;
      case "request_enrollment":
        result = await options.host.requestEnrollment(input.username, identity);
        break;
      case "approve_enrollment":
        result = await options.host.approveEnrollment(input.username, identity);
        break;
    }
    context.header("Cache-Control", "no-store");
    return context.body(JSON.stringify(result), 200, { "Content-Type": "application/json" });
  });
  app.get("/v1/minecraft/configuration", async (context) => {
    const identity = await options.authorize(context.req.raw);
    if (!(await admitted(identity))) return context.json({ error: "operator_required" }, 403);
    if (!options.settings) return context.json({ error: "minecraft_settings_unavailable" }, 503);
    const settings = await options.settings.load();
    if (!(await admitted(identity))) return context.json({ error: "operator_revoked" }, 403);
    context.header("Cache-Control", "no-store");
    return context.json(settings.minecraft);
  });
  app.put("/v1/minecraft/configuration", async (context) => {
    const identity = await options.authorize(context.req.raw);
    if (!(await admitted(identity))) return context.json({ error: "operator_required" }, 403);
    if (!options.settings?.update) return context.json({ error: "minecraft_settings_unavailable" }, 503);
    const parsed = MinecraftSettingsSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!parsed.success) return context.json({ error: "invalid_minecraft_configuration" }, 400);
    if (!(await admitted(identity))) return context.json({ error: "operator_revoked" }, 403);
    try {
      const settings = await options.settings.update(
        (current) => ({ ...current, minecraft: parsed.data }),
        async () => {
          if (!(await admitted(identity))) throw new Error("operator_revoked");
        },
      );
      return context.json(settings.minecraft);
    } catch {
      const allowed = await admitted(identity);
      return context.json(
        { error: allowed ? "minecraft_configuration_failed" : "operator_revoked" },
        allowed ? 500 : 403,
      );
    }
  });
  app.get("/v1/minecraft", async (context) => {
    const identity = await options.authorize(context.req.raw);
    if (!(await admitted(identity))) return context.json({ error: "operator_required" }, 403);
    if (!options.service) return context.json({ error: "minecraft_unavailable" }, 503);
    const result = await options.service.status(identity!);
    if (!(await admitted(identity))) return context.json({ error: "operator_revoked" }, 403);
    context.header("Cache-Control", "no-store");
    return context.json(result);
  });
  app.post("/v1/minecraft", async (context) => {
    const identity = await options.authorize(context.req.raw);
    if (!(await admitted(identity))) return context.json({ error: "operator_required" }, 403);
    const parsed = MinecraftCommandSchema.safeParse(await context.req.json().catch(() => undefined));
    if (!parsed.success) return context.json({ error: "invalid_minecraft_command" }, 400);
    if (!options.service) return context.json({ error: "minecraft_unavailable" }, 503);
    try {
      const result = await dispatch(options.service, parsed.data, identity!);
      if (!(await admitted(identity))) return context.json({ error: "operator_revoked" }, 403);
      context.header("Cache-Control", "no-store");
      return context.json(result);
    } catch (error) {
      if (error instanceof MinecraftServiceError)
        return context.json(
          {
            error: error.code,
            ...(error.bodyLease === undefined ? {} : { bodyLease: error.bodyLease }),
          },
          409,
        );
      return context.json({ error: "minecraft_operation_failed" }, 503);
    }
  });
  return app;
}
