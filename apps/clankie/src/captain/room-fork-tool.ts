import { z } from "zod";
import { ROOM_FORK_TOOL, type RoomForkInput } from "./captain-discord-turns.ts";
import type { LaneTool, LaneToolResult } from "./port.ts";
import type { RoomForkResult } from "./room-forks.ts";

const RoomForkArgsSchema = z
  .object({
    room: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe("Room conversation ID from the conversations list. Give this or channel."),
    channel: z
      .string()
      .regex(/^\d{5,32}$/u)
      .optional()
      .describe(
        "Discord text channel ID in a server your bot body admits, for a channel with no room conversation yet. Give this or room.",
      ),
    brief: z
      .string()
      .trim()
      .min(1)
      .max(8_000)
      .describe(
        "Everything the room turn needs from you: the task, what to say or post, relevant facts. It is the only context from your conversation the room ever sees.",
      ),
    replyTo: z
      .string()
      .regex(/^\d{5,32}$/u)
      .optional()
      .describe("Discord message ID to answer; the post replies to it."),
    file: z
      .object({
        path: z
          .string()
          .min(1)
          .max(4_096)
          .describe(
            "File to attach, relative to the operator conversation's working directory (the service's own, not your harness's cwd or scratch folder) or absolute inside it. Copy a file there first; anything outside is refused as delivered_file_outside_conversation_workspace.",
          ),
        filename: z.string().min(1).max(200).optional(),
      })
      .strict()
      .optional()
      .describe("A finished file to post with the message or reply."),
    requestId: z
      .string()
      .regex(/^[A-Za-z0-9._:-]{8,128}$/u)
      .optional()
      .describe("Reuse to retry safely; an identical request is deduplicated without it."),
  })
  .strict()
  .refine((args) => (args.room === undefined) !== (args.channel === undefined), {
    message: "Give exactly one of room or channel.",
  });

/**
 * The owner's seat forks a turn into a Discord room (ADR 0218, 2026-10-06).
 * Owner-only by construction: it is only added to an operator-lane bank.
 */
export function roomForkTool(
  fork: (input: Omit<RoomForkInput, "sourceConversationId" | "workspace">) => Promise<RoomForkResult>,
): LaneTool {
  return {
    name: ROOM_FORK_TOOL,
    description:
      "Post in a Discord room by forking a turn into it, named by its room conversation or, for a channel you have not talked in yet, its channel ID. The room turn runs with that room's own grants and Discord mouth, reads the room's own recent conversation plus your brief (never your transcript), decides the exact words, and posts. In a room only your owner can read it may use machine tools and private context; anywhere else it is a social one-shot that knows only the room and your brief. Returns what it posted, its message ID, or why not.",
    inputSchema: z.toJSONSchema(RoomForkArgsSchema) as Record<string, unknown>,
    call: async (args): Promise<LaneToolResult> => {
      const parsed = RoomForkArgsSchema.safeParse(args);
      if (!parsed.success)
        return { content: [{ type: "text", text: parsed.error.message.slice(0, 1_000) }], isError: true };
      const { room, channel, file, replyTo, requestId, ...rest } = parsed.data;
      const result = await fork({
        ...rest,
        ...(room === undefined ? {} : { room }),
        ...(channel === undefined ? {} : { channel }),
        ...(replyTo === undefined ? {} : { replyTo }),
        ...(requestId === undefined ? {} : { requestId }),
        ...(file === undefined
          ? {}
          : {
              file: { path: file.path, ...(file.filename === undefined ? {} : { filename: file.filename }) },
            }),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        ...(result.state === "posted" || result.state === "silent" ? {} : { isError: true }),
      };
    },
  };
}
