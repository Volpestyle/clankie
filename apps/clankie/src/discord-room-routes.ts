import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  DISCORD_ROOMS_PATH,
  DISCORD_ROOM_GUIDANCE_PATH,
  DISCORD_SETTINGS_PATH,
  DiscordRoomGuidanceRequestSchema,
  DiscordSettingsUpdateSchema,
  discordSetupDefinition,
  discordServerSettings,
  DiscordSettingsSchema,
  discordRoleInviteUrl,
  DISCORD_ADMIN_INVITE_PERMISSIONS,
  DISCORD_PARTICIPANT_INVITE_PERMISSIONS,
  DISCORD_DIRECTORY_PATH,
  DiscordDirectoryRequestSchema,
  type DiscordDirectoryRequest,
  type DiscordDirectorySnapshot,
  type DiscordPermissionsRequest,
  type DiscordPermissionsSnapshot,
  type DiscordBodyTestPostRequest,
  type DiscordSetupTestPostResult,
  DiscordSetupTestPostRequestSchema,
  DISCORD_SETUP_TEST_POST_PATH,
} from "@clankie/protocol";
import type { ClankieSettings } from "@clankie/settings";
import { resolveDiscordSettings } from "@clankie/settings";
import type { CaptainPort } from "./captain/port.ts";
import type { DiscordRoomObservations } from "./discord-room-observations.ts";
import { discordSetupChecks } from "./discord-setup.ts";

export type RoomAccess = "observe" | "guidance" | "settings";
export interface RoomAuthorization {
  guard(): Promise<void>;
  current(): boolean;
}
export interface DiscordRoomRoutesOptions {
  /** Host name, or “his cloud computer” for a hosted runtime. */
  machineName?: string;
  permissions?(
    query: DiscordPermissionsRequest,
    body: DiscordDirectorySnapshot["body"],
  ): Promise<DiscordPermissionsSnapshot>;
  testPost?(
    query: DiscordBodyTestPostRequest,
    body: DiscordDirectorySnapshot["body"],
  ): Promise<DiscordSetupTestPostResult>;
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
const SNOWFLAKE = /^\d{5,}$/u;

/**
 * The room as a device lists it: the place alone, `#channel · server` or the
 * person in a DM. The kind travels as the room's lane, and a room whose names
 * the host has not heard yet has no title rather than raw Discord IDs. Stored
 * titles keep their full form for the captain and the TUI.
 */
export function discordRoomDisplayTitle(title: string): string | undefined {
  const match = /^Discord (?:text|voice|DM) · (.+)$/su.exec(title);
  if (match === null) return title;
  const place = match[1]!.trim();
  const split = place.lastIndexOf(" / ");
  if (split < 0) return /^\d+(?::\d+)?$/u.test(place) ? undefined : place;
  const server = place.slice(0, split).trim();
  const channel = place.slice(split + 3).trim();
  if (SNOWFLAKE.test(channel.replace(/^#/u, ""))) return undefined;
  return SNOWFLAKE.test(server) ? channel : `${channel} · ${server}`;
}

export function createDiscordRoomRoutes(options: DiscordRoomRoutesOptions): Hono {
  const app = new Hono();
  const setup = async (settings: ClankieSettings["discord"]) => {
    const effective = resolveDiscordSettings(settings, options.environment ?? {}).settings;
    const body = effective.activeBody;
    return options.machineName
      ? {
          setup: {
            definition: discordSetupDefinition(effective),
            machineName: options.machineName,
            ...(effective.applicationId
              ? {
                  invite: {
                    role: effective.role,
                    permissions:
                      effective.role === "admin"
                        ? DISCORD_ADMIN_INVITE_PERMISSIONS
                        : DISCORD_PARTICIPANT_INVITE_PERMISSIONS,
                    url: discordRoleInviteUrl(effective.applicationId, effective.role, effective.serverId),
                  },
                }
              : {}),
            ...(options.permissions
              ? {
                  checks: await discordSetupChecks(effective, (query) => options.permissions!(query, body)),
                }
              : {}),
            ...(options.testPost ? { testPostAvailable: true } : {}),
          },
        }
      : {};
  };
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
              .filter((room) => room.scope.kind === "room" && room.roomHandoff === undefined)
              .map((room) => ({
                ...options.observations.status(room.conversationId),
                ...(discordRoomDisplayTitle(room.title) === undefined
                  ? {}
                  : { title: discordRoomDisplayTitle(room.title) }),
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
    if (
      room.op !== "get" ||
      room.conversation?.scope.kind !== "room" ||
      room.conversation.roomHandoff !== undefined
    )
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
    const metadata = await setup(settings);
    if (
      discordSettingsRevision((await options.settings.load()).discord) !== discordSettingsRevision(settings)
    )
      return context.json({ error: "settings_revision_conflict" }, 409);
    await authority.guard();
    if (!authority.current()) return context.json({ error: "room_observe_required" }, 403);
    return context.json({
      settings,
      revision: discordSettingsRevision(settings),
      ...metadata,
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
    const request: unknown = await context.req.json();
    const parsed = DiscordSettingsUpdateSchema.safeParse(request);
    if (!parsed.success) return context.json({ error: "invalid_discord_settings" }, 400);
    if (!options.settings.update) return context.json({ error: "settings_unavailable" }, 503);
    const updated = await options.settings.update(
      (current) => {
        if (!authority.current()) throw new Error("operator_revoked");
        if (discordSettingsRevision(current.discord) !== parsed.data.expectedRevision)
          throw new Error("settings_revision_conflict");
        // Older clients cannot carry the new server model back. Omission must
        // preserve current authority rather than resetting role/toggles to defaults.
        const incoming = (request as { settings: Record<string, unknown> }).settings;
        const serverModelWriter = ["role", "fleetEnabled", "trackingLevel"].every((key) =>
          Object.hasOwn(incoming, key),
        );
        const discord = { ...parsed.data.settings };
        for (const key of [
          "serverId",
          "role",
          "fleetEnabled",
          "fleetChannelId",
          "trackingLevel",
          "teamVisible",
        ] as const)
          if (
            !Object.hasOwn(incoming, key) &&
            !(serverModelWriter && (key === "serverId" || key === "fleetChannelId"))
          )
            (discord as Record<string, unknown>)[key] = current.discord[key];
        return {
          ...current,
          discord: discordServerSettings(DiscordSettingsSchema.parse(discord), current.discord),
        };
      },
      async () => {
        await authority.guard();
        if (!authority.current()) throw new Error("operator_revoked");
      },
    );
    const metadata = await setup(updated.discord);
    if (
      discordSettingsRevision((await options.settings.load()).discord) !==
      discordSettingsRevision(updated.discord)
    )
      return context.json({ error: "settings_revision_conflict" }, 409);
    await authority.guard();
    if (!authority.current()) return context.json({ error: "operator_revoked" }, 403);
    return context.json({
      settings: updated.discord,
      revision: discordSettingsRevision(updated.discord),
      ...metadata,
    });
  });
  app.post(DISCORD_SETUP_TEST_POST_PATH, async (context) => {
    const authority = await options.authorize(context.req.raw, "settings");
    if (!authority) return context.json({ error: "operator_required" }, 403);
    const parsed = DiscordSetupTestPostRequestSchema.safeParse(await context.req.json());
    if (!parsed.success) return context.json({ error: "invalid_discord_test_post" }, 400);
    if (!options.permissions || !options.testPost)
      return context.json({ outcome: "unavailable", reason: "runtime_unavailable" });
    const query = parsed.data;
    const current = (await options.settings.load()).discord;
    if (discordSettingsRevision(current) !== query.expectedRevision)
      return context.json({ error: "settings_revision_conflict" }, 409);
    const body = resolveDiscordSettings(current, options.environment ?? {}).settings.activeBody;
    const permissions = await options.permissions(
      { guildId: query.guildId, channelId: query.channelId },
      body,
    );
    if (
      !permissions.actorId ||
      permissions.body !== body ||
      permissions.guildId !== query.guildId ||
      permissions.channelId !== query.channelId ||
      permissions.permissions.send_messages !== "passed"
    )
      return context.json({ outcome: "unavailable", reason: "permissions_not_verified" });
    await authority.guard();
    if (!authority.current()) return context.json({ error: "operator_revoked" }, 403);
    const fresh = (await options.settings.load()).discord;
    if (
      discordSettingsRevision(fresh) !== query.expectedRevision ||
      resolveDiscordSettings(fresh, options.environment ?? {}).settings.activeBody !== body
    )
      return context.json({ error: "settings_revision_conflict" }, 409);
    await authority.guard();
    if (!authority.current() || context.req.raw.signal.aborted)
      return context.json({ error: "operator_revoked" }, 403);
    // Only this explicit, authenticated POST reaches the native mutation.
    return context.json(
      await options.testPost(
        { guildId: query.guildId, channelId: query.channelId, actorId: permissions.actorId },
        body,
      ),
    );
  });
  return app;
}
