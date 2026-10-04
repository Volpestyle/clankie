import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { MinecraftCommandSchema, type MinecraftCommand } from "@clankie/protocol";
import { MinecraftSettingsSchema, type SettingsStore } from "@clankie/settings";
import type { BodyConversationIdentity } from "./body-lease-router.ts";
import { MinecraftServiceError, type MinecraftService } from "./minecraft.ts";

export interface MinecraftRouteOptions {
  readonly service?: MinecraftService;
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
