import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  DISCORD_ROOMS_PATH,
  DISCORD_ROOM_GUIDANCE_PATH,
  DISCORD_SETTINGS_PATH,
  DiscordRoomGuidanceRequestSchema,
  DiscordSettingsUpdateSchema,
  DISCORD_SETUP_DEFINITION,
  DISCORD_DIRECTORY_PATH,
  DiscordDirectoryRequestSchema,
  type DiscordDirectoryRequest,
  type DiscordDirectorySnapshot,
} from "@clankie/protocol";
import type { ClankieSettings } from "@clankie/settings";
import { resolveDiscordSettings } from "@clankie/settings";
import type { CaptainPort } from "./captain/port.ts";
import type { DiscordRoomObservations } from "./discord-room-observations.ts";

export type RoomAccess = "observe" | "guidance" | "settings";
export interface RoomAuthorization {
  guard(): Promise<void>;
  current(): boolean;
}
export interface DiscordRoomRoutesOptions {
  /** Host name, or “his cloud computer” for a hosted runtime. */
  machineName?: string;
  directory?(
    query: DiscordDirectoryRequest,
    body: DiscordDirectorySnapshot["body"],
  ): Promise<DiscordDirectorySnapshot>;
  environment?: NodeJS.ProcessEnv;
  authorize(request: Request, access: RoomAccess): Promise<RoomAuthorization | undefined>;
  captain: Pick<CaptainPort, "serveOperatorConversation">;
  observations: DiscordRoomObservations;
  settings: {
    load(): Promise<ClankieSettings>;
    update?(
      mutate: (current: ClankieSettings) => ClankieSettings,
      guard?: () => Promise<void>,
    ): Promise<ClankieSettings>;
  };
}
export function discordSettingsRevision(settings: ClankieSettings["discord"]): string {
  return createHash("sha256").update(JSON.stringify(settings)).digest("hex");
}
export function createDiscordRoomRoutes(options: DiscordRoomRoutesOptions): Hono {
  const app = new Hono();
  // Mounted at the service root: scope middleware to this module's own paths so
  // its body limit never reaches unrelated routes (seat transcripts, uploads).
  app.use("/v1/discord/*", bodyLimit({ maxSize: 32 * 1024 }));
  app.use("/v1/discord/*", async (context, next) => {
    context.header("cache-control", "no-store");
    await next();
  });
  app.onError((error, context) =>
    context.json(
      {
        error:
          error.message === "guidance_revision_conflict" || error.message === "settings_revision_conflict"
            ? error.message
            : "room_access_unavailable",
      },
      error.message.endsWith("revision_conflict") ? 409 : 403,
    ),
  );
  app.get(DISCORD_ROOMS_PATH, async (context) => {
    const authority = await options.authorize(context.req.raw, "observe");
    if (!authority) return context.json({ error: "room_observe_required" }, 403);
    const result = await options.captain.serveOperatorConversation({ op: "list", schemaVersion: 1 });
    await authority.guard();
    if (!authority.current()) return context.json({ error: "room_observe_required" }, 403);
    return context.json({
      rooms:
        result.op === "list"
          ? result.conversations
              .filter((room) => room.scope.kind === "room")
              .map((room) => ({
                ...options.observations.status(room.conversationId),
                title: room.title,
                ...(room.scope.kind === "room"
                  ? { lane: room.scope.lane, targetId: room.scope.targetId }
                  : {}),
              }))
          : [],
    });
  });
  app.post(DISCORD_ROOM_GUIDANCE_PATH, async (context) => {
    const authority = await options.authorize(context.req.raw, "guidance");
    if (!authority) return context.json({ error: "room_guidance_required" }, 403);
    const parsed = DiscordRoomGuidanceRequestSchema.safeParse(await context.req.json());
    if (!parsed.success) return context.json({ error: "invalid_room_guidance" }, 400);
    const room = await options.captain.serveOperatorConversation({
      op: "get",
      schemaVersion: 1,
      conversationId: parsed.data.conversationId,
    });
    await authority.guard();
    if (!authority.current()) return context.json({ error: "room_guidance_required" }, 403);
    if (room.op !== "get" || room.conversation?.scope.kind !== "room")
      return context.json({ error: "room_not_found" }, 404);
    return context.json(
      options.observations.setGuidance(
        parsed.data.conversationId,
        parsed.data.text,
        parsed.data.expectedRevision,
        async () => {
          await authority.guard();
          if (!authority.current()) throw new Error("room_guidance_revoked");
        },
        authority.current,
      ),
    );
  });
  app.get(DISCORD_SETTINGS_PATH, async (context) => {
    const authority = await options.authorize(context.req.raw, "observe");
    if (!authority) return context.json({ error: "room_observe_required" }, 403);
    const settings = (await options.settings.load()).discord;
    await authority.guard();
    if (!authority.current()) return context.json({ error: "room_observe_required" }, 403);
    return context.json({
      settings,
      revision: discordSettingsRevision(settings),
      ...(options.machineName
        ? { setup: { definition: DISCORD_SETUP_DEFINITION, machineName: options.machineName } }
        : {}),
    });
  });
  app.get(DISCORD_DIRECTORY_PATH, async (context) => {
    const authority = await options.authorize(context.req.raw, "observe");
    if (!authority) return context.json({ error: "room_observe_required" }, 403);
    const query = DiscordDirectoryRequestSchema.safeParse(context.req.query());
    if (!query.success) return context.json({ error: "invalid_discord_directory_request" }, 400);
    const body = resolveDiscordSettings((await options.settings.load()).discord, options.environment ?? {})
      .settings.activeBody;
    const snapshot = options.directory
      ? await options.directory(query.data, body)
      : {
          schemaVersion: 1 as const,
          body,
          kind: query.data.kind,
          state: "disconnected" as const,
          entries: [],
          hasMore: false,
          reason: "runtime_not_connected" as const,
        };
    const freshBody = resolveDiscordSettings(
      (await options.settings.load()).discord,
      options.environment ?? {},
    ).settings.activeBody;
    await authority.guard();
    if (!authority.current()) return context.json({ error: "room_observe_required" }, 403);
    if (freshBody !== body) return context.json({ error: "discord_body_changed" }, 409);
    return context.json(snapshot);
  });
  app.post(DISCORD_SETTINGS_PATH, async (context) => {
    const authority = await options.authorize(context.req.raw, "settings");
    if (!authority) return context.json({ error: "operator_required" }, 403);
    const parsed = DiscordSettingsUpdateSchema.safeParse(await context.req.json());
    if (!parsed.success) return context.json({ error: "invalid_discord_settings" }, 400);
    if (!options.settings.update) return context.json({ error: "settings_unavailable" }, 503);
    const updated = await options.settings.update(
      (current) => {
        if (!authority.current()) throw new Error("operator_revoked");
        if (discordSettingsRevision(current.discord) !== parsed.data.expectedRevision)
          throw new Error("settings_revision_conflict");
        // An older client's response schema cannot carry this additive field
        // back. Omission preserves its current gate; explicit true restores it.
        return {
          ...current,
          discord: {
            ...parsed.data.settings,
            ...(parsed.data.settings.teamVisible === undefined && current.discord.teamVisible !== undefined
              ? { teamVisible: current.discord.teamVisible }
              : {}),
          },
        };
      },
      async () => {
        await authority.guard();
        if (!authority.current()) throw new Error("operator_revoked");
      },
    );
    await authority.guard();
    if (!authority.current()) return context.json({ error: "operator_revoked" }, 403);
    return context.json({
      settings: updated.discord,
      revision: discordSettingsRevision(updated.discord),
      ...(options.machineName
        ? { setup: { definition: DISCORD_SETUP_DEFINITION, machineName: options.machineName } }
        : {}),
    });
  });
  return app;
}
