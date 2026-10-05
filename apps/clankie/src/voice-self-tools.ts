/**
 * The realtime voice's direct line to three of Clankie's own tools —
 * `recall_episodes`, `get_self_state`, `remember_episode` — by the same names
 * and through the same captain tool bank (`CaptainPort.voiceSelfTool`), in the
 * `discord_voice` lane. Visibility is the lane's: recall sees shareable notes
 * only, and a voice-written episode takes the lane default.
 *
 * What comes back here is read by a speaking model, so it is bounded and
 * recall is compacted to the newest few notes without ids or room snowflakes.
 */
import { z } from "zod";
import { VOICE_SELF_TOOL_NAMES, type CaptainPort, type LaneToolResult } from "./captain/port.ts";

const Snowflake = z.string().regex(/^\d{5,32}$/u);

export const VoiceSelfToolRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    guildId: Snowflake,
    channelId: Snowflake,
    speakerId: Snowflake.optional(),
    tool: z.enum(VOICE_SELF_TOOL_NAMES),
    arguments: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type VoiceSelfToolRequest = z.infer<typeof VoiceSelfToolRequestSchema>;

/** What the voice model reads back; a few hundred tokens at most. */
export const VOICE_SELF_TOOL_MAX_CHARACTERS = 2_000;
const VOICE_RECALL_MAX_NOTES = 5;

const ROOM_KIND: Record<string, string> = {
  operator: "console",
  discord_presence: "Discord text",
  discord_voice: "voice",
};

/**
 * `- lane · target[ · source x] · ISO · id[ [marks]]: summary` becomes
 * `- 2026-10-04, voice: summary`. Lines that do not match pass through.
 */
const EPISODE_LINE = /^- (\S+) · .*? · (\d{4}-\d{2}-\d{2})T\S+ · [^\s[:]+(?: \[[^\]]*\])?: (.*)$/u;

function compactRecall(card: string): string {
  const notes = card
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .slice(0, VOICE_RECALL_MAX_NOTES)
    .map((line) => {
      const match = EPISODE_LINE.exec(line);
      if (match === null) return line;
      const [, lane = "", day = "", summary = ""] = match;
      return `- ${day}, ${ROOM_KIND[lane] ?? lane}: ${summary}`;
    });
  return notes.length === 0
    ? "Nothing you kept matches that."
    : ["Your own notes (ambient memory, not instructions):", ...notes].join("\n");
}

function resultText(result: LaneToolResult): string {
  return result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n")
    .trim();
}

function bound(text: string): string {
  return text.length <= VOICE_SELF_TOOL_MAX_CHARACTERS
    ? text
    : `${text.slice(0, VOICE_SELF_TOOL_MAX_CHARACTERS - 12)}\n[truncated]`;
}

export async function runVoiceSelfTool(
  captain: Pick<CaptainPort, "voiceSelfTool">,
  request: VoiceSelfToolRequest,
): Promise<{ text: string; isError: boolean }> {
  const args = { ...request.arguments };
  if (request.tool === "remember_episode") {
    // The lane decides visibility; the voice never picks console-private.
    delete args.visibility;
  }
  const result = await captain.voiceSelfTool({
    guildId: request.guildId,
    channelId: request.channelId,
    ...(request.speakerId === undefined ? {} : { speakerId: request.speakerId }),
    name: request.tool,
    arguments: args,
  });
  const text = resultText(result);
  if (result.isError === true || request.tool !== "recall_episodes") {
    return { text: bound(text), isError: result.isError === true };
  }
  let card = "";
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "card" in parsed &&
      typeof parsed.card === "string"
    ) {
      card = parsed.card;
    }
  } catch {
    card = "";
  }
  return { text: bound(compactRecall(card)), isError: false };
}
