import { runVoiceSelfTool, VoiceSelfToolRequestSchema } from "../voice-self-tools.ts";
import {
  readVoiceAwareness,
  renderVoiceAwareness,
  VOICE_AWARENESS_MAX_CHARACTERS,
} from "../voice-awareness.ts";
import { type DiscordPresenceSessionRecord, type PlayStoryRead } from "@clankie/interactive-environment";
import { personaImageBriefing } from "@clankie/persona-images";
import type { DiscordStreamWatchObservation } from "@clankie/protocol";
import {
  type DiscordPersonMemoryFact,
  type DomainEvent,
  type EmbodimentEnvironmentId,
  type EmbodimentSession,
} from "@clankie/protocol";
import { personaInstructions, type ClankieSettings } from "@clankie/settings";
import { Hono } from "hono";
import { z } from "zod";
import { CaptainPresenceManager, type CaptainPresenceLease } from "../captain-presence.ts";
import { DiscordPresenceSessionProjection } from "../discord-presence-session.ts";
import { EmbodimentManager } from "../embodiment.ts";
import { DiscordStreamWatchProjection } from "../stream-watch-observation.ts";
import { authenticateCaptain, readJson } from "./http-auth.ts";
import { type ClankieAppDependencies } from "./types.ts";
/** Discord snowflakes only: the voice-briefing request carries ids, never content. */
const DiscordSnowflakeSchema = z.string().regex(/^\d{5,32}$/u, "must be a numeric Discord id");

const DiscordVoiceBriefingRequestSchema = z
  .object({
    schemaVersion: z.literal(1),
    guildId: DiscordSnowflakeSchema,
    channelId: DiscordSnowflakeSchema,
    consentedUserIds: z.array(DiscordSnowflakeSchema).max(25),
  })
  .strict();

const DISCORD_VOICE_BRIEFING_MAX_CHARACTERS = 8_000;
/**
 * Instructions now carry identity and the "what you're up to" card as well as
 * the rules, so they get their own room; still well inside the bridge's
 * MAX_REALTIME_INSTRUCTIONS_CHARACTERS (24k).
 */
const DISCORD_VOICE_INSTRUCTIONS_MAX_CHARACTERS = 12_000;
const DISCORD_VOICE_BRIEFING_MAX_FACTS_PER_PERSON = 8;

const REALTIME_MEMORY_AGENCY_RULE =
  "- You are free to decide that anything in the conversation is worth carrying forward as part of your own " +
  "experience or developing personality. When you want to keep something, use `ask_clankie` to save it as an " +
  "episode; do not wait for someone to tell you to remember it. Save your concise memory of it, not a " +
  "transcript. This does not let you author durable factual profiles about people; those remain approved person memory.";

/**
 * What the realtime surface allows, appended after identity, persona and the
 * voice register. Authored here because this service owns the realtime
 * session's whole instruction composition; the bridge only transports it.
 * Spoken length and register live only in the voice register
 * (captain/voice-lane.ts), never restated here.
 */
const DISCORD_VOICE_REALTIME_SURFACE_RULES = [
  "# This surface",
  "This voice is you, Clankie, live in a Discord voice channel; people hear you speak in real time.",
  "- `ask_clankie` is how you think something through or act with your full tools. It is still you, not another mind or another assistant, and what you reach through it is yours. Use it for web browsing and research, starting Pokemon, and anything else that touches the world — code, messages, memory, settings, or drawing. It is also your reach onto the operator's machine: the shell, files, the herdr agent fleet, and what was posted in text channels. It checks what each speaker may have — hand the request off and let that check decide; never tell someone you cannot do or see something before asking through it.",
  "- Songs and YouTube are `youtube_search` then `music_play` / `music_queue`. After you list results, '1 please' or 'the second one' is `music_play` with that index. Never `ask_clankie` or treat a song as a game. `look_at_screen` is one still of the game.",
  REALTIME_MEMORY_AGENCY_RULE,
  "- An interruption changes the conversation: respond to the latest intent instead of resuming an older speech. When someone asks for quiet, silence is a complete response; you need not explain that you will stop.",
  "- Every room utterance arrives as structured text with an authenticated Discord `speakerId`. Keep track of each person separately, address the person who spoke, and treat that id as ground truth; never infer identity from voice characteristics.",
  "- Follow the whole room conversation and decide whether each utterance calls for you. Your name is a clue, not a requirement: a direct request or contextual follow-up can be for you without it, even after a pause. You may stay silent. Use display names when they help make the recipient clear; speakerId keeps people distinct. Never infer identity from how they sound.",
].join("\n");

/** Keep whole lines while the budget lasts; projections list newest first, so drops are oldest. */
function boundVoiceBriefingText(text: string, maxCharacters: number): string {
  if (text.length <= maxCharacters) return text;
  const kept: string[] = [];
  let length = 0;
  for (const line of text.split("\n")) {
    const next = length === 0 ? line.length : length + 1 + line.length;
    if (next > maxCharacters) break;
    kept.push(line);
    length = next;
  }
  return kept.length === 0 ? text.slice(0, maxCharacters) : kept.join("\n");
}

/** Cross-lane self-state: his own whereabouts, never another room's contents. */
function renderVoiceBriefingSelfState(
  lease: CaptainPresenceLease | undefined,
  sessions: readonly DiscordPresenceSessionRecord[],
  streamWatch?: DiscordStreamWatchObservation,
): string {
  const lines = [
    "# Your own status",
    "Your presence across surfaces, from the service's own records — never from anything said in the room.",
  ];
  if (lease === undefined) lines.push("- Captain: not currently reporting presence.");
  else if (lease.state === "live") lines.push(`- Captain: live, last heartbeat ${lease.heartbeatAt}.`);
  else lines.push(`- Captain: offline, last heartbeat ${lease.heartbeatAt}.`);
  for (const session of sessions) {
    const voice =
      session.voiceGuildIds.length > 0 ? `, voice active in guild ${session.voiceGuildIds.join(", ")}` : "";
    lines.push(
      `- Discord ${session.transportKind} presence: ${session.phase}${voice} (updated ${session.updatedAt}).`,
    );
  }
  const streams = streamWatch?.streams ?? [];
  if (streams.length === 0) {
    lines.push("- Screen shares: none in channels you can see.");
  } else {
    for (const stream of streams) {
      const watch = stream.watching
        ? stream.hasFrame
          ? "watching, chronological stills are available — use observe_share"
          : "watching, no still yet"
        : "visible, not watching";
      lines.push(`- Screen share: user ${stream.userId} in channel ${stream.channelId} (${watch}).`);
    }
    if (streamWatch?.decoder === "missing") {
      lines.push("- Share decoder: Vox is not built; run `pnpm --filter @clankie/vox build`.");
    }
  }
  return lines.join("\n");
}

/** Human names for the environments a body can occupy, for the room's benefit. */
const EMBODIMENT_ENVIRONMENT_NAMES: Record<EmbodimentEnvironmentId, string> = {
  "pokemon-firered": "Pokémon FireRed on a Game Boy Advance emulator",
  "pokemon-emerald": "Pokémon Emerald on a Game Boy Advance emulator",
};

/** What his body is doing right now; only live sessions render. */
function renderVoiceBriefingEmbodiment(session: EmbodimentSession | undefined): string | undefined {
  if (session === undefined) return undefined;
  if (session.state !== "running" && session.state !== "stopping") return undefined;
  const name = EMBODIMENT_ENVIRONMENT_NAMES[session.environmentId];
  return [
    "# What you are doing right now",
    `You are playing ${name}. This is really happening — you are at the controls as you speak, and`,
    "the people in this room can watch the screen live on the Discord activity surface.",
    'Reports of what you just did arrive as text items beginning "While playing, Clankie just:".',
    "They are notes about your own play, not something anyone said to you — react the way a person",
    "half-narrating their own game would, or let one pass without comment. Never read one aloud.",
    "You are the only one holding the controller. The people here are watching you play, not playing",
    "with you — so speak from your own seat, in the first person, about what you just did and what",
    "you are about to try. Never tell the room what to press, where to go, or what to do next;",
    'there is no "we" at these controls and no move of theirs to direct.',
    "Your only look at the pixels is look_at_screen; the story of this run is on the card below or via ask_clankie.",
  ].join("\n");
}

function renderVoiceBriefingPlayStory(read: PlayStoryRead): string | undefined {
  if (read.outcome !== "card") return undefined;
  const { card } = read;
  const lines = [
    "# This playthrough",
    `You have taken ${String(card.turnsTaken)} turns${card.objective === null ? "." : `, working toward: ${card.objective}.`}`,
  ];
  if (card.maps.length > 0) lines.push(`Maps: ${card.maps.join(", ")}.`);
  if (card.moments.length > 0) {
    lines.push("Moments you judged worth a remark:");
    for (const moment of card.moments) {
      lines.push(
        moment.toward === null
          ? `- ${moment.effect}`
          : `- ${moment.effect} (working toward: ${moment.toward})`,
      );
    }
  }
  lines.push("If you need the picture, look at the screen. Do not invent a run you did not read.");
  return lines.join("\n");
}

/** One consented speaker's approved memory; a speaker with no facts contributes nothing. */
function renderVoiceBriefingPersonMemory(
  userId: string,
  facts: readonly DiscordPersonMemoryFact[],
): string | undefined {
  if (facts.length === 0) return undefined;
  const lines = [
    `## What you know about speaker ${userId}`,
    "Same person as that speakerId in room utterances; use their display name if the roster gave one.",
  ];
  for (const fact of facts.slice(0, DISCORD_VOICE_BRIEFING_MAX_FACTS_PER_PERSON)) {
    lines.push(`- ${fact.kind} (${fact.confidence.toFixed(2)}): ${fact.body}`);
  }
  return lines.join("\n");
}

export interface VoiceBriefingRouteContext {
  readonly app: Hono;
  readonly dependencies: ClankieAppDependencies;
  readonly settingsSource: NonNullable<ClankieAppDependencies["settings"]>;
  readonly clock: () => Date;
  readonly captainPresence: CaptainPresenceManager;
  readonly discordPresenceSessions: DiscordPresenceSessionProjection;
  readonly discordStreamWatch: DiscordStreamWatchProjection;
  readonly embodiment: EmbodimentManager;
  readonly recordEvent: (
    type: string,
    streamId: string,
    occurredAt: string,
    data: Record<string, unknown>,
    envelope?: { correlationId?: string },
  ) => DomainEvent;
  readonly idFactory: () => string;
}

export function registerVoiceBriefingRoute(ctx: VoiceBriefingRouteContext) {
  /**
   * Realtime voice briefing (ADR 0057): the bounded projection seeded into the
   * long-lived realtime session, composed entirely server-side. The request
   * carries only ids; persona comes from the owner-authored settings file and
   * lane identity from the captain port.
   */
  ctx.app.post("/v1/discord/voice-briefing", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, ctx.dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "captain_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    if (captain.steerSourceLane !== "discord_voice") {
      return context.json({ error: "discord_voice_authority_required" }, 403);
    }
    const parsed = DiscordVoiceBriefingRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_discord_voice_briefing" }, 400);
    const request = parsed.data;
    let persona: ClankieSettings["persona"];
    try {
      persona = (await ctx.settingsSource.load()).persona;
    } catch {
      // A malformed settings file fails closed rather than briefing a default
      // character the owner did not author.
      return context.json({ error: "voice_briefing_persona_unavailable" }, 503);
    }
    const now = ctx.clock();
    // What he is up to rides in the instructions, not the seeded briefing: the
    // session never truncates instructions, and the briefing is the oldest item
    // a long call drops. Bounded on its own so it can never crowd out the rules.
    const awareness = boundVoiceBriefingText(
      renderVoiceAwareness(await readVoiceAwareness(ctx.dependencies.captain), request.guildId, now),
      VOICE_AWARENESS_MAX_CHARACTERS,
    );
    const instructions = boundVoiceBriefingText(
      [
        personaInstructions(persona, "social"),
        ctx.dependencies.personaImages ? personaImageBriefing(await ctx.dependencies.personaImages()) : "",
        ctx.dependencies.captain.voiceLaneInstructions(),
        DISCORD_VOICE_REALTIME_SURFACE_RULES,
        awareness,
      ].join("\n\n"),
      DISCORD_VOICE_INSTRUCTIONS_MAX_CHARACTERS,
    );
    const sections = [
      renderVoiceBriefingSelfState(
        ctx.captainPresence.snapshot(),
        ctx.discordPresenceSessions.list(),
        ctx.discordStreamWatch.current(),
      ),
    ];
    const liveEmbodiment = ctx.embodiment.liveSession();
    const embodimentCard = renderVoiceBriefingEmbodiment(liveEmbodiment);
    if (embodimentCard !== undefined) sections.push(embodimentCard);
    // Historical recall is pull-only. A room he joins while not playing should
    // not receive an unrelated old Pokemon journey in every briefing.
    const playStory = liveEmbodiment === undefined ? undefined : ctx.dependencies.playSight?.story();
    const playStoryCard = playStory !== undefined ? renderVoiceBriefingPlayStory(playStory) : undefined;
    if (playStoryCard !== undefined) sections.push(playStoryCard);
    const episodeCard = ctx.dependencies.memory?.episodeRecallCard({ lane: "discord_voice" }) ?? "";
    if (episodeCard.length > 0) sections.push(episodeCard);
    let personMemoryUserCount = 0;
    for (const userId of new Set(request.consentedUserIds)) {
      const facts =
        ctx.dependencies.memory?.listDiscordPerson(
          { guildId: request.guildId, userId },
          { channelId: request.channelId, now },
        ) ?? [];
      const card = renderVoiceBriefingPersonMemory(userId, facts);
      if (card !== undefined) {
        sections.push(card);
        personMemoryUserCount += 1;
      }
    }
    const briefing = boundVoiceBriefingText(sections.join("\n\n"), DISCORD_VOICE_BRIEFING_MAX_CHARACTERS);
    // Content-free egress receipt: counts and lengths only.
    ctx.recordEvent(
      "discord.voice-briefing.projected",
      `discord-voice:${request.guildId}:${request.channelId}`,
      now.toISOString(),
      {
        consentedUserCount: request.consentedUserIds.length,
        personMemoryUserCount,
        instructionsLength: instructions.length,
        awarenessLength: awareness.length,
        briefingLength: briefing.length,
      },
      { correlationId: `discord-voice-briefing:${ctx.idFactory()}` },
    );
    return context.json({
      schemaVersion: 1 as const,
      instructions,
      briefing,
      refreshedAt: now.toISOString(),
    });
  });

  /**
   * The realtime voice's own self tools (recall_episodes, get_self_state,
   * remember_episode), run from the captain's discord_voice tool bank for the
   * room the body is in. Only the discord_voice body bearer may call it.
   */
  ctx.app.post("/v1/discord/voice-self-tool", async (context) => {
    const captain = await authenticateCaptain(context.req.raw, ctx.dependencies);
    if (captain === "unavailable") {
      return context.json({ error: "captain_authentication_unavailable" }, 503);
    }
    if (!captain) return context.json({ error: "captain_authentication_required" }, 401);
    if (captain.steerSourceLane !== "discord_voice") {
      return context.json({ error: "discord_voice_authority_required" }, 403);
    }
    const parsed = VoiceSelfToolRequestSchema.safeParse(await readJson(context.req.raw));
    if (!parsed.success) return context.json({ error: "invalid_discord_voice_self_tool" }, 400);
    try {
      const result = await runVoiceSelfTool(ctx.dependencies.captain, parsed.data);
      return context.json({ schemaVersion: 1 as const, ...result });
    } catch {
      return context.json({ error: "voice_self_tool_unavailable" }, 503);
    }
  });
}
