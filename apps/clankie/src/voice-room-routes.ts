import {
  DISCORD_ROOM_VOICE_PATH,
  DISCORD_VOICE_OUTPUT_GUARD_PATH,
  DiscordRoomVoiceCommandSchema,
  DiscordVoiceOutputControlSchema,
} from "@clankie/protocol";
import { readJson } from "./app/http-auth.ts";
import type { DiscordRoomVoice } from "./discord-room-voice.ts";
import type { ExtensionRoutes } from "./ports/routes.ts";

/**
 * Voice's room routes: read and steer his voice stay in a Discord room, and the
 * Discord body's output guard. They mount through the core's route host and use
 * its room, caller and conversation checks (ADR 0328). Without a room voice they
 * still answer, as unavailable.
 */
export function voiceRoomRoutes(roomVoice?: DiscordRoomVoice): ExtensionRoutes {
  return {
    place: "body",
    register: (app, host) => {
      app.get(DISCORD_ROOM_VOICE_PATH, async (context) => {
        const authority = await host.room(context.req.raw, "observe");
        if (!authority) return context.json({ error: "room_observe_required" }, 403);
        if (!roomVoice) return context.json({ error: "voice_unavailable" }, 503);
        try {
          const status = await roomVoice.status();
          await authority.guard();
          if (!authority.current()) return context.json({ error: "room_observe_required" }, 403);
          context.header("cache-control", "no-store");
          return context.json(status);
        } catch {
          return context.json({ error: "voice_unavailable" }, 503);
        }
      });
      app.post(DISCORD_ROOM_VOICE_PATH, async (context) => {
        const authority = await host.room(context.req.raw, "settings");
        if (!authority) return context.json({ error: "operator_required" }, 403);
        const parsed = DiscordRoomVoiceCommandSchema.safeParse(await readJson(context.req.raw));
        if (!parsed.success) return context.json({ error: "invalid_voice_control" }, 400);
        if (!roomVoice) return context.json({ error: "voice_unavailable" }, 503);
        const command = parsed.data;
        if (command.action === "join") {
          const room = await host.conversations.serveOperatorConversation({
            op: "get",
            schemaVersion: 1,
            conversationId: command.conversationId,
          });
          const settings = await host.settings.load();
          if (
            room.op !== "get" ||
            room.conversation?.scope.kind !== "room" ||
            room.conversation.scope.lane !== "discord_voice" ||
            !settings.discord.ownerUserId
          )
            return context.json({ error: "exact_voice_room_required" }, 409);
          try {
            return context.json(
              await roomVoice.join(
                command.conversationId,
                room.conversation.scope.targetId,
                settings.discord.ownerUserId,
                authority,
              ),
            );
          } catch {
            return context.json({ error: "voice_control_refused" }, 409);
          }
        }
        if (
          (command.action !== "mute_output" &&
            command.action !== "unmute_output" &&
            command.action !== "leave") ||
          command.stayId === undefined
        )
          return context.json({ error: "voice_control_unsupported" }, 409);
        try {
          return context.json(
            await roomVoice.control(command.conversationId, command.stayId, command.action, authority),
          );
        } catch {
          return context.json({ error: "voice_control_refused" }, 409);
        }
      });
      app.post(DISCORD_VOICE_OUTPUT_GUARD_PATH, async (context) => {
        const parsed = DiscordVoiceOutputControlSchema.safeParse(await readJson(context.req.raw));
        const captain = await host.captainCaller(context.req.raw);
        if (
          !captain ||
          captain === "unavailable" ||
          (captain.steerSourceLane !== "discord_voice" && captain.steerSourceLane !== "discord_text")
        )
          return context.json({ error: "discord_body_required" }, 403);
        if (!parsed.success || !roomVoice) return context.json({ error: "voice_control_unknown" }, 403);
        try {
          await roomVoice.authorize(parsed.data);
          return context.json({ authorized: true });
        } catch {
          return context.json({ error: "voice_control_unknown" }, 403);
        }
      });
    },
  };
}
