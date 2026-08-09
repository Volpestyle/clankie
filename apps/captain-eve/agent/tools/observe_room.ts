import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { captainLaneKind } from "../../lib/lanes/context.ts";
import {
  captainRooms,
  MAX_ENTRIES_CEILING,
  readCaptainRoom,
  UnknownCaptainRoomError,
} from "../../lib/lanes/rooms.ts";

/**
 * Looking in on one of his other rooms ([ADR 0084](../../../../docs/adr/0084-the-head-can-read-his-branches.md)).
 *
 * Every other room he answers in is a durable Eve session he had no way to
 * read: asked in the console whether he had used his browser over in Discord,
 * he could only say he could not see that room's transcript from there. The
 * head is supposed to see what its branches do.
 *
 * **Offered in the operator lane only.** Transparency runs down-chain, not
 * sideways: the supervising seat reads every room, and an ambient Discord,
 * voice, or gameplay turn — where the conversation is untrusted and anyone can
 * ask him anything — gets no reach into the others. The gate is the trusted
 * channel context resolved here at session start, never a tool argument: a tool
 * executor receives the AI SDK's options rather than the eve session context,
 * so it cannot check its own lane, and an argument could be prompt-injected.
 */
export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => {
      // A dynamic resolver that throws takes the turn down with it, and
      // `captainLaneKind` throws on a channel kind it does not recognise. An
      // unreadable lane is not the operator lane, so it simply gets no tool.
      let lane: string;
      try {
        lane = captainLaneKind(ctx.channel);
      } catch {
        return null;
      }
      if (lane !== "operator") return null;
      return defineTool({
        description:
          "Look in on one of your own other rooms — a Discord server or channel, voice, gameplay, " +
          "another operator conversation — and read what is going on there: what people said to you, " +
          "what you said back, which tools you called with what arguments, and what came back. Use it " +
          'whenever you are asked about anywhere else ("what is going on in text?", "did you use your ' +
          'browser in Discord?", "what did you tell them in #general?") instead of saying you cannot ' +
          "see that room — you can, so look before you answer. Call it with no room to list the rooms " +
          "you can read. Entries are marked by kind: `heard` is what someone said to you there, `said` " +
          "is your own reply. It is a read and only a read; looking into a room never speaks in it.",
        inputSchema: z.object({
          room: z
            .string()
            .trim()
            .max(512)
            .optional()
            .describe(
              "Which room, as a key from the listing (discord_presence:GUILD:CHANNEL), a bare target id, " +
                "a lane name for its most recent room, or any distinctive fragment. Omit to list rooms.",
            ),
          maxEntries: z.number().int().min(1).max(MAX_ENTRIES_CEILING).optional(),
        }),
        execute: async (input: { room?: string; maxEntries?: number }) => {
          if (input.room === undefined || input.room.length === 0) {
            return {
              rooms: (await captainRooms()).map((room) => ({
                room: room.key,
                lane: room.lane,
                state: room.state,
                updatedAt: room.updatedAt,
                readableSessions: room.sessionIds.length,
              })),
              note: "Call this again with one of these room keys to read what you did there.",
            };
          }
          try {
            return await readCaptainRoom(
              input.room,
              input.maxEntries === undefined ? {} : { maxEntries: input.maxEntries },
            );
          } catch (error) {
            if (!(error instanceof UnknownCaptainRoomError)) throw error;
            return {
              unknownRoom: input.room,
              rooms: error.rooms.map((room) => room.key),
              note: "No room of yours matches that. Say so plainly rather than guessing what happened there.",
            };
          }
        },
      });
    },
  },
});
