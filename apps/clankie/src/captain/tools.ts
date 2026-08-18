import {
  CAPTAIN_EPISODE_SUMMARY_MAX,
  DrawErDiagramRequestSchema,
  DrawSequenceDiagramRequestSchema,
  type CaptainSessionLaneV2,
  type CaptainTurnMedia,
  type DrawDiagramResult,
  isAttachableTurnMediaRef,
} from "@clankie/protocol";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  truncateHead,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { GameplaySettings } from "@clankie/settings";
import { Type, type TSchema } from "typebox";
import type { CaptainDeps } from "./deps.ts";
import type { LaneLog } from "./lane-log.ts";
import { joinWorld, startPlay, stopPlay } from "./play.ts";

/**
 * What the running turn is, as its tools need to see it: the last attachable
 * thing it produced (which rides the reply), and which room it is happening in
 * (which scopes every room-keyed read and write a tool makes).
 */
export interface TurnContext {
  media?: CaptainTurnMedia | undefined;
  /**
   * Stable key for the room this turn is in. Sessions are per-room in every
   * durable case and per-turn otherwise, so this is set once per turn and read
   * at tool-execution time.
   */
  room?: string | undefined;
  /** Host-stamped room target; models never choose episode provenance. */
  targetId?: string | undefined;
  /** Discord actor who triggered this turn. Host-stamped; models never choose it. */
  actorId?: string | undefined;
  /** Discord guild for this turn. Host-stamped; absent in DMs and non-Discord rooms. */
  guildId?: string | undefined;
  /** Discord channel and trigger message for grounded social actions. */
  channelId?: string | undefined;
  messageId?: string | undefined;
}

/** Room key, stable across a room's turns and distinct across rooms. */
export function roomKey(lane: string, targetId: string): string {
  return `${lane}:${targetId}`;
}

export function toolJson(value: unknown): { content: [{ type: "text"; text: string }]; details: unknown } {
  const serialized = JSON.stringify(value, null, 2) ?? String(value);
  const truncated = truncateHead(serialized, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  const text = truncated.truncated
    ? `${truncated.content}\n\n[Output truncated to ${String(truncated.outputBytes)} of ${String(truncated.totalBytes)} bytes; request a narrower result.]`
    : truncated.content;
  return { content: [{ type: "text", text }], details: value };
}

const json = toolJson;

/**
 * The captain's authored tool bank. Coding tools (read/bash/edit/write) are
 * pi built-ins and are not defined here. They attach to the operator console
 * and to Discord text turns whose actor is on `systemActorUserIds`. Herdr
 * leadership goes through bash + the herdr skill, not bespoke tools.
 */
export function captainTools(
  deps: CaptainDeps,
  turn: TurnContext,
  laneLog: LaneLog,
  lane: CaptainSessionLaneV2,
  gameplay: GameplaySettings = { pokemonEmulatorEnabled: true, pokeagentMmoEnabled: true },
): ToolDefinition[] {
  const playPorts = {
    submitEmbodimentIntent: deps.embodiment.submitIntent,
    getEmbodimentSession: deps.embodiment.getSession,
    getLiveEmbodimentSession: deps.embodiment.getLiveSession,
  };
  const enabled = new Set([
    ...(gameplay.pokemonEmulatorEnabled ? ["pokeagent_start_solo"] : []),
    ...(gameplay.pokeagentMmoEnabled ? ["pokeagent_join_mmo"] : []),
    ...(gameplay.pokemonEmulatorEnabled || gameplay.pokeagentMmoEnabled
      ? ["pokeagent_stop", "pokeagent_observe", "pokeagent_recall"]
      : []),
  ]);
  return [
    defineTool({
      name: "generate_image",
      label: "Draw a picture",
      description:
        "Draw a picture. Describe what you want in the prompt as fully as you like — subject, style, mood, colours. " +
        "You can also change a picture you made earlier by passing its sourceRef along with what to change. " +
        "In a Discord channel the picture is attached to your reply automatically, so make it and then talk about " +
        "it normally; never paste the reference into your message. 'refused' names a reason you can say out loud: " +
        "'no_model_configured' means nobody has picked an image model yet (/image-model), 'credential_unavailable' " +
        "means there is no API key stored for it. A refusal is something to mention, not retry.",
      parameters: Type.Object({
        prompt: Type.String({ minLength: 1, maxLength: 4000 }),
        aspectRatio: Type.Optional(
          Type.String({ description: "Shape like 16:9 or 1:1. Omit to let the model choose." }),
        ),
        sourceRef: Type.Optional(
          Type.String({
            description: "artifactRef from an earlier generate_image result, to edit that picture.",
          }),
        ),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const result = await deps.media.generateImage({ schemaVersion: 1, ...params });
        if (result.outcome === "ok")
          turn.media = { artifactRef: result.artifactRef, filename: result.filename };
        return json(result);
      },
    }),
    defineTool({
      name: "generate_video",
      label: "Make a video",
      description:
        "Make a short video from a prompt. A result of 'pending' is normal — it is still rendering; say so, and " +
        "know that it keeps rendering after you answer. You will be told in this room when it lands, and calling " +
        "again with the same requestId then hands you the finished video. Never start a second render of the " +
        "same idea. In a Discord channel a finished video attaches itself to your reply, like a picture does.",
      parameters: Type.Object({
        prompt: Type.String({ minLength: 1, maxLength: 4000 }),
        requestId: Type.Optional(Type.String({ description: "Resume a render that came back pending." })),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const result = await deps.media.generateVideo({ schemaVersion: 1, ...params }, turn.room);
        if (result.outcome === "ok")
          turn.media = { artifactRef: result.artifactRef, filename: result.filename };
        return json(result);
      },
    }),
    ...diagramTools(deps, turn),
    defineTool({
      name: "pokeagent_start_solo",
      label: "PokeAgent: start solo",
      description:
        "Start a solo PokeAgent session on your own GBA body (Pokemon FireRed or Emerald), live on the activity watch surface. " +
        "Not for songs or YouTube — those are youtube_search / music_play. Not a hosted world with other players — " +
        "that is pokeagent_join_mmo. The session resumes from your latest " +
        "checkpoint and keeps going until someone asks you to stop; people can watch. 'started' means you are " +
        "playing; 'start_refused' names a reason you can say out loud (body_held means someone else is already " +
        "driving your body); 'pending' means it is still spinning up — say so, never claim to be playing yet.",
      parameters: Type.Object({
        environmentId: StringEnum(["pokemon-firered", "pokemon-emerald"], {
          default: "pokemon-firered",
        }),
      }),
      execute: async (_id, params) =>
        json(
          await startPlay(playPorts, {
            environmentId: params.environmentId as "pokemon-firered" | "pokemon-emerald",
            originLane: lane,
            requestedBy: turnActor(turn, lane),
          }),
        ),
    }),
    defineTool({
      name: "pokeagent_join_mmo",
      label: "PokeAgent: join MMO",
      description:
        "Join the hosted PokeAgent MMO where other Pokemon players already exist, live on the activity watch surface. " +
        "Not your own private cartridge — that is pokeagent_start_solo. You land in a session someone else is hosting; " +
        "you can see who else is here. 'joined' means you are in the world; 'join_refused' names a reason you " +
        "can say out loud (no_credential means nobody provisioned you a seat, world_unreachable means the host " +
        "is down, world_full means there is no room, region_not_hosted means that game is not up, world_refused " +
        "means the world said no); 'pending' means it is still spinning up — say so, never claim to be playing yet.",
      parameters: Type.Object({
        environmentId: Type.Union([Type.Literal("pokemon-firered"), Type.Literal("pokemon-emerald")], {
          default: "pokemon-firered",
        }),
      }),
      execute: async (_id, params) =>
        json(
          await joinWorld(playPorts, {
            environmentId: params.environmentId,
            originLane: lane,
            requestedBy: turnActor(turn, lane),
          }),
        ),
    }),
    ...discordVoicePresenceTools(deps, turn, lane),
    ...discordActionTools(deps, turn, lane),
    ...discordMusicTools(deps, turn, lane),
    defineTool({
      name: "pokeagent_stop",
      label: "PokeAgent: stop",
      description:
        "Stop the live PokeAgent session, solo or MMO. The result is what actually happened; a session that was " +
        "already stopped is not an error worth apologising for.",
      parameters: Type.Object({}),
      execute: async () =>
        json(await stopPlay(playPorts, { originLane: lane, requestedBy: turnActor(turn, lane) })),
    }),
    defineTool({
      name: "observe_share",
      label: "Look at a screen share",
      description:
        "Look at a Discord screen share in a voice channel you can see. Returns up to four chronological " +
        "stills, oldest to newest, when " +
        "the lab user body is watching it. If someone is sharing but you have no still, say that — do not invent " +
        "what is on their screen. Use it when someone asks what is on the share, what they are looking at, or " +
        "what is on screen in the call.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => {
        const observation = await deps.streamWatch.current();
        if (observation.streams.length === 0) {
          return json({
            outcome: "none",
            detail: "nobody is sharing a screen in a channel you can see",
          });
        }
        const frame = observation.frame;
        if (frame === undefined) {
          return json({
            outcome: "listed",
            streams: observation.streams,
            decoder: observation.decoder,
            ...(observation.decoderDetail === undefined ? {} : { decoderDetail: observation.decoderDetail }),
            detail:
              observation.decoder === "missing"
                ? "someone is sharing but Vox is not built, so you cannot see the picture"
                : "someone is sharing but you do not have a still yet",
          });
        }
        if (frame.artifactRef !== undefined && isAttachableTurnMediaRef(frame.artifactRef)) {
          turn.media = { artifactRef: frame.artifactRef, filename: `share-${frame.userId}.jpg` };
        }
        const frames = observation.frames?.length ? observation.frames : [frame];
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                outcome: "frame",
                streams: observation.streams,
                sequence: "oldest_to_newest",
                frameCount: frames.length,
                capturedAt: frames.map((sample) => sample.capturedAt),
                userId: frame.userId,
                detail:
                  frames.length > 1
                    ? "Compare these chronological samples to infer coarse motion or change."
                    : "Only one sample is available, so do not infer motion.",
              }),
            },
            ...frames.map((sample) => ({
              type: "image" as const,
              data: sample.jpegBase64,
              mimeType: "image/jpeg" as const,
            })),
          ],
          details: { outcome: "frame", streams: observation.streams, frameCount: frames.length },
        };
      },
    }),
    defineTool({
      name: "pokeagent_observe",
      label: "PokeAgent: look at screen",
      description:
        "Look at the current PokeAgent session — its latest Pokemon frame and status. " +
        "Use it when someone asks what you are doing, what is on screen, or how the run is going. " +
        "When a still is available it arrives as an image; say what you actually see.",
      parameters: Type.Object({}),
      executionMode: "sequential",
      execute: async () => {
        const activity = await deps.activity.current();
        const still = (await deps.playSight?.still()) ?? {
          schemaVersion: 1 as const,
          outcome: "not_playing" as const,
        };
        if (still.outcome !== "still") return json({ ...activity, still: { outcome: still.outcome } });
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ...activity,
                still: {
                  outcome: "still",
                  width: still.width,
                  height: still.height,
                  sha256: still.sha256,
                },
              }),
            },
            { type: "image" as const, data: still.pngBase64, mimeType: "image/png" },
          ],
          details: { activity, still: { outcome: "still" } },
        };
      },
    }),
    defineTool({
      name: "pokeagent_recall",
      label: "PokeAgent: recall session",
      description:
        "Read the current PokeAgent session's story so far: where you are, what you are after, and the last few moments " +
        "you judged worth a remark. The card includes the latest settled-turn time and only exists while the run is live; " +
        "a gap means the player is deciding, not that it is stuck. Not the raw journal. Use it when someone asks how you " +
        "got here or what has happened in the run. Say when you are not playing rather than inventing a playthrough.",
      parameters: Type.Object({}),
      execute: async () =>
        json((await deps.playSight?.story()) ?? { schemaVersion: 1, outcome: "not_playing" }),
    }),
    defineTool({
      name: "observe_room",
      label: "Read another room",
      description:
        "Read the recent conversation in one of your other rooms. Entries come marked — 'heard' is what someone " +
        "said to you there, 'said' is your own reply. Say when a room has been quiet rather than inventing " +
        "activity, and never describe a room you did not actually read. Call with no arguments to list rooms.",
      parameters: Type.Object({
        lane: Type.Optional(
          Type.String({ description: "Room lane, e.g. discord_presence, discord_voice, operator." }),
        ),
        targetId: Type.Optional(Type.String({ description: "The room's target id as listed." })),
      }),
      execute: async (_id, params) => {
        // The operator's room is private. From any other lane it does not
        // exist: not listed, not readable — a Discord room must never be able
        // to talk him into repeating what was said at the console.
        const visible = (roomLane: string): boolean => lane === "operator" || roomLane !== "operator";
        if (params.lane === undefined || params.targetId === undefined) {
          const lanes = await laneLog.list(5);
          return json(
            lanes
              .filter((room) => visible(room.lane))
              .map(({ lane: roomLane, targetId, entries }) => ({
                lane: roomLane,
                targetId,
                recent: entries.length,
              })),
          );
        }
        if (!visible(params.lane)) {
          return json({ refused: "that room is not readable from here" });
        }
        return json(await laneLog.read(params.lane, params.targetId));
      },
    }),
    defineTool({
      name: "get_self_state",
      label: "Check on yourself",
      description:
        "A present-tense card of what you are doing right now: live play session, Discord presence, who holds " +
        "your body, closed voice stays, and recent voice speech scalars (spoken vs suppressed — never words). " +
        "Read it before answering questions about yourself. voiceHistory is closed stays only and is empty " +
        "while you are still in the channel; recentVoiceSpeech.currentStay is whether you have been talking.",
      parameters: Type.Object({}),
      execute: async () => {
        const [live, sessions, possession, voiceHistory, voiceSpeech, renders, shares] = await Promise.all([
          deps.embodiment.getLiveSession(),
          deps.presence.listSessions(),
          deps.embodiment.getPossession(),
          deps.presence.listVoiceHistory(5),
          deps.presence.listRecentVoiceSpeech(12),
          // Only this room's renders: what he was asked to make elsewhere is
          // not this room's business, same rule as `observe_room`.
          turn.room === undefined ? [] : deps.media.finishedRenders(turn.room),
          deps.streamWatch.current(),
        ]);
        return json({
          liveSession: live,
          presenceSessions: sessions,
          bodyPossession: possession,
          voiceHistory,
          recentVoiceSpeech: voiceSpeech,
          finishedRenders: renders,
          activeStreams: shares.streams,
          shareDecoder: shares.decoder,
        });
      },
    }),
    defineTool({
      name: "remember_episode",
      label: "Remember this",
      description:
        "Write one short episode into your own memory for this room — something that happened that you want to " +
        "still know tomorrow. Facts, not transcripts.",
      parameters: Type.Object({
        summary: Type.String({ minLength: 1, maxLength: CAPTAIN_EPISODE_SUMMARY_MAX }),
        visibility: Type.Optional(StringEnum(["shareable", "operator_private"])),
      }),
      execute: async (_id, params) => {
        if (turn.targetId === undefined) throw new Error("Turn room attribution is unavailable");
        await deps.memory.appendEpisode({
          lane,
          targetId: turn.targetId,
          summary: params.summary,
          ...(params.visibility === undefined
            ? {}
            : { visibility: params.visibility as "shareable" | "operator_private" }),
        });
        return json({ remembered: true });
      },
    }),
  ].filter((tool) => !tool.name.startsWith("pokeagent_") || enabled.has(tool.name));
}

function turnActor(turn: TurnContext, lane: CaptainSessionLaneV2): string {
  if (lane === "operator") return "owner";
  if (lane === "gameplay") return "clankie";
  if (turn.actorId === undefined) throw new Error("Turn actor attribution is unavailable");
  return turn.actorId;
}

function discordVoicePresenceTools(
  deps: CaptainDeps,
  turn: TurnContext,
  lane: CaptainSessionLaneV2,
): ToolDefinition[] {
  if (!lane.startsWith("discord_") && lane !== "operator") return [];
  const voice = deps.discordVoicePresence;
  const call = async (action: "join" | "leave") => {
    if (voice === undefined) {
      return json({ action: action === "join" ? "join_refused" : "leave_refused", reason: "failed" });
    }
    if (lane === "operator") return json(await voice[action]({}));
    const guildId = turn.guildId;
    const actorId = turn.actorId;
    if (guildId === undefined || actorId === undefined) {
      return json({ action: action === "join" ? "join_refused" : "leave_refused", reason: "failed" });
    }
    return json(await voice[action]({ guildId, actorId }));
  };
  const fromOperator = lane === "operator";
  return [
    defineTool({
      name: "voice_join",
      label: "Join voice",
      description: fromOperator
        ? "Join the Discord voice channel the owner is in now. Use this when they ask you from the console to " +
          "join, hop in, come talk, or otherwise enter their call. The live Discord body—not you—finds that " +
          "channel from gateway state and enforces allowlists. You never pick a guild or channel. A refusal " +
          "reason is a fact to explain, not a reason to retry: not_in_voice means they are not in a call, " +
          "ambiguous means they are in more than one, no_owner means nobody is configured as the owner. " +
          "On success, actorCanBeHeard says whether the owner can be heard under the room's current consent policy. " +
          "If false, tell them to use /clankie voice-consent opt-in before you can hear them; if true, plainly disclose " +
          "that their audio is transcribed live and may remain with the configured provider for this call."
        : "Join the Discord voice channel the person speaking to you is in now. Use this when they ask you to " +
          "join, hop in, come talk, or otherwise enter their call. The live Discord body—not you—resolves the " +
          "channel and enforces authority and allowlists. A refusal reason is a fact to explain, not a reason to retry. " +
          "On success, actorCanBeHeard says whether the speaker can be heard under the room's current consent policy. " +
          "If false, tell them to use /clankie voice-consent opt-in before you can hear them; if true, plainly disclose " +
          "that their audio is transcribed live and may remain with the configured provider for this call.",
      parameters: Type.Object({}),
      execute: () => call("join"),
    }),
    defineTool({
      name: "voice_leave",
      label: "Leave voice",
      description: fromOperator
        ? "Leave your active Discord voice channel when the operator asks you to leave, hang up, or dip. The live " +
          "Discord body enforces authority and prevents one server from ending a call in another."
        : "Leave your active Discord voice channel when someone asks you to leave, hang up, or dip. The live " +
          "Discord body enforces authority and prevents one server from ending a call in another.",
      parameters: Type.Object({}),
      execute: () => call("leave"),
    }),
  ];
}

function discordActionTools(
  deps: CaptainDeps,
  turn: TurnContext,
  lane: CaptainSessionLaneV2,
): ToolDefinition[] {
  if (!lane.startsWith("discord_") || deps.discordActions === undefined) return [];
  const context = (callId: string) => {
    if (turn.actorId === undefined || turn.channelId === undefined || turn.messageId === undefined) {
      throw new Error("Discord turn attribution is unavailable");
    }
    return {
      callId,
      actorId: turn.actorId,
      ...(turn.guildId === undefined ? {} : { guildId: turn.guildId }),
      channelId: turn.channelId,
      messageId: turn.messageId,
    };
  };
  const textActions =
    lane === "discord_presence"
      ? [
          defineTool({
            name: "discord_react",
            label: "React to message",
            description:
              "Add a reaction to the Discord message you are answering. Use your own social judgment.",
            parameters: Type.Object({ emoji: Type.String({ minLength: 1, maxLength: 64 }) }),
            execute: (callId, params) =>
              deps
                .discordActions!.execute({ action: "react", ...context(callId), emoji: params.emoji })
                .then(json),
          }),
          defineTool({
            name: "discord_unreact",
            label: "Remove reaction",
            description: "Remove one of your reactions from the Discord message you are answering.",
            parameters: Type.Object({ emoji: Type.String({ minLength: 1, maxLength: 64 }) }),
            execute: (callId, params) =>
              deps
                .discordActions!.execute({ action: "unreact", ...context(callId), emoji: params.emoji })
                .then(json),
          }),
          defineTool({
            name: "discord_create_thread",
            label: "Start a thread",
            description:
              "Start a Discord thread from the message you are answering when the conversation deserves one.",
            parameters: Type.Object({ name: Type.String({ minLength: 1, maxLength: 100 }) }),
            execute: (callId, params) =>
              deps
                .discordActions!.execute({ action: "create_thread", ...context(callId), name: params.name })
                .then(json),
          }),
          defineTool({
            name: "discord_join_thread",
            label: "Join thread",
            description: "Join the current Discord thread when you want to participate in it.",
            parameters: Type.Object({}),
            execute: (callId) =>
              deps.discordActions!.execute({ action: "join_thread", ...context(callId) }).then(json),
          }),
        ]
      : [];
  return [
    ...textActions,
    defineTool({
      name: "discord_watch_start",
      label: "Start sharing play",
      description:
        "Show your live play surface in the speaker's current voice channel. The body chooses its supported " +
        "Discord surface and freshly resolves the speaker's voice channel; a refusal is a fact, not a retry cue.",
      parameters: Type.Object({}),
      execute: (callId) => {
        const grounded = context(callId);
        if (grounded.guildId === undefined) {
          return Promise.resolve(json({ ok: false, message: "Voice needs a server." }));
        }
        return deps
          .discordActions!.execute({ action: "watch_start", ...grounded, guildId: grounded.guildId })
          .then(json);
      },
    }),
    defineTool({
      name: "discord_watch_stop",
      label: "Stop sharing play",
      description: "Stop offering your live play surface in the speaker's current voice channel.",
      parameters: Type.Object({}),
      execute: (callId) => {
        const grounded = context(callId);
        if (grounded.guildId === undefined) {
          return Promise.resolve(json({ ok: false, message: "Voice needs a server." }));
        }
        return deps
          .discordActions!.execute({ action: "watch_stop", ...grounded, guildId: grounded.guildId })
          .then(json);
      },
    }),
  ];
}

/**
 * His drawing hand (ADR 0096).
 *
 * He describes the diagram; the host draws it. The parameters are the picture's
 * *content* — entities and their fields, participants and the messages between
 * them — and never canvas code, which is what lets these tools sit on every
 * lane rather than only the ones that hold a shell. The design system is fixed,
 * so his attention goes to what the diagram says.
 */
function discordMusicTools(
  deps: CaptainDeps,
  turn: TurnContext,
  lane: CaptainSessionLaneV2,
): ToolDefinition[] {
  const music = deps.discordMusic;
  const author = (): string => turnActor(turn, lane);
  const unavailable = () =>
    json({
      ok: false,
      message: "The live Discord body is not accepting music right now. I need to be in a voice channel.",
    });
  return [
    defineTool({
      name: "youtube_search",
      label: "Search YouTube",
      description:
        "Search YouTube for a song or video to play in Discord voice. Returns numbered results. " +
        "Read them to the room and ask which one, then music_play or music_queue with that url or index. " +
        "Use this when someone wants a song, a track, or YouTube — not pokeagent_start_solo (that is Pokemon).",
      parameters: Type.Object({
        query: Type.String({ minLength: 1, maxLength: 200 }),
        next: Type.Optional(Type.Boolean({ description: "True if they asked to play it next / queue it." })),
      }),
      execute: async (_id, params) => {
        if (music === undefined) return unavailable();
        return json(
          await music.search({ query: params.query, next: params.next === true, authorId: author() }),
        );
      },
    }),
    defineTool({
      name: "music_play",
      label: "Play a track",
      description:
        "Play a YouTube track now in the active Discord body. Pass a url from youtube_search, or the " +
        "1-based index of the last search you ran for this person.",
      parameters: Type.Object({
        url: Type.Optional(Type.String({ maxLength: 2000 })),
        index: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
      }),
      execute: async (_id, params) => {
        if (music === undefined) return unavailable();
        return json(
          await music.play({
            ...(typeof params.url === "string" ? { url: params.url } : {}),
            ...(typeof params.index === "number" ? { index: params.index } : {}),
            authorId: author(),
          }),
        );
      },
    }),
    defineTool({
      name: "music_queue",
      label: "Queue a track",
      description: "Queue a YouTube track after the current one. Same arguments as music_play.",
      parameters: Type.Object({
        url: Type.Optional(Type.String({ maxLength: 2000 })),
        index: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
      }),
      execute: async (_id, params) => {
        if (music === undefined) return unavailable();
        return json(
          await music.queue({
            ...(typeof params.url === "string" ? { url: params.url } : {}),
            ...(typeof params.index === "number" ? { index: params.index } : {}),
            authorId: author(),
          }),
        );
      },
    }),
    defineTool({
      name: "music_skip",
      label: "Skip track",
      description: "Skip the current Discord track.",
      parameters: Type.Object({}),
      execute: async () =>
        json(music === undefined ? { ok: false, message: "no music body" } : await music.skip()),
    }),
    defineTool({
      name: "music_pause",
      label: "Pause track",
      description: "Pause Discord music.",
      parameters: Type.Object({}),
      execute: async () =>
        json(music === undefined ? { ok: false, message: "no music body" } : await music.pause()),
    }),
    defineTool({
      name: "music_resume",
      label: "Resume track",
      description: "Resume paused Discord music.",
      parameters: Type.Object({}),
      execute: async () =>
        json(music === undefined ? { ok: false, message: "no music body" } : await music.resume()),
    }),
    defineTool({
      name: "music_stop",
      label: "Stop music",
      description: "Stop Discord music and clear the queue.",
      parameters: Type.Object({}),
      execute: async () =>
        json(music === undefined ? { ok: false, message: "no music body" } : await music.stop()),
    }),
    defineTool({
      name: "music_now",
      label: "Now playing",
      description: "What is playing and what is queued in Discord voice.",
      parameters: Type.Object({}),
      execute: async () =>
        json(music === undefined ? { ok: false, message: "no music body" } : await music.now()),
    }),
  ];
}

function diagramTools(deps: CaptainDeps, turn: TurnContext): ToolDefinition[] {
  const diagrams = deps.diagrams;
  if (diagrams === undefined) return [];
  const attach = (result: DrawDiagramResult): void => {
    if (result.outcome === "ok") turn.media = { artifactRef: result.artifactRef, filename: result.filename };
  };
  return [
    defineTool({
      name: "draw_er_diagram",
      label: "Draw an ER diagram",
      description:
        "Draw an entity-relationship diagram of a data model. Give one entry in 'tables' per entity and write " +
        "its 'columns' as one field per line, 'ROLES|field|type' — roles are any comma-separated mix of PK, SK " +
        "and FK, and an empty first cell is a plain field, so 'PK|id|uuid' and '|created_at|timestamptz' are " +
        "both ordinary lines. Put where the rows actually live in 'engine' (postgres, memory, redis, whatever " +
        "is true) and keep prose out of the type cells: constraints and lifecycle notes belong in 'footer'. " +
        "'edges' draws the relationships — name the two tables and the exact fields the keys sit on, and label " +
        "each with its cardinality. Tables lay out in columns of three in the order you list them, so put " +
        "related entities next to each other and prefer short hops; a foreign key you draw no edge for still " +
        "reads fine from its type cell. In a Discord channel the picture attaches to your reply automatically, " +
        "so draw it and then talk about it normally. 'refused' with 'canvas_unavailable' means the tldraw app " +
        "is not open on the mac — say so, that is something a human can fix and not something to retry.",
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 120 }),
        subtitle: Type.Optional(Type.String({ maxLength: 240, description: "One line under the title." })),
        tables: Type.Array(
          Type.Object({
            name: Type.String({ minLength: 1, maxLength: 60 }),
            engine: Type.Optional(Type.String({ maxLength: 60 })),
            tone: Type.Optional(
              StringEnum(["black", "grey", "blue", "green", "yellow", "orange", "red", "violet"], {
                description: "Group related tables by colour.",
              }),
            ),
            columns: Type.String({ minLength: 1, maxLength: 4000 }),
            footer: Type.Optional(Type.String({ maxLength: 600 })),
          }),
          { minItems: 1, maxItems: 16 },
        ),
        edges: Type.Optional(
          Type.Array(
            Type.Object({
              from: Type.String({ minLength: 1, maxLength: 60 }),
              fromField: Type.String({ minLength: 1, maxLength: 60 }),
              to: Type.String({ minLength: 1, maxLength: 60 }),
              toField: Type.String({ minLength: 1, maxLength: 60 }),
              label: Type.Optional(Type.String({ maxLength: 80 })),
            }),
            { maxItems: 32 },
          ),
        ),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const result = await diagrams.drawErDiagram(
          DrawErDiagramRequestSchema.parse({ schemaVersion: 1, ...params }),
        );
        attach(result);
        return json(result);
      },
    }),
    defineTool({
      name: "draw_sequence_diagram",
      label: "Draw a sequence diagram",
      description:
        "Draw a sequence diagram of an exchange over time. 'lanes' is one participant per line, left to right, " +
        "as 'id|Label|sublabel' — the id is what the steps refer to, the sublabel says what the thing is " +
        "('client', 'postgres', 'the worker'). 'steps' is the exchange, one per line: '== phase name' rules off " +
        "a section, 'a->b: message' is a call, 'a-->b: message' is a reply, 'a->a: message' is something a " +
        "participant does to itself, and 'note over a,b: text' is an aside spanning those lanes. End a step " +
        "with '[red]' to mark the failure path. Keep to five or six lanes; past that it reads as a wall. In a " +
        "Discord channel the picture attaches to your reply automatically. 'refused' with 'canvas_unavailable' " +
        "means the tldraw app is not open on the mac — say so rather than retrying.",
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 120 }),
        lanes: Type.String({ minLength: 1, maxLength: 1200 }),
        steps: Type.String({ minLength: 1, maxLength: 8000 }),
      }),
      executionMode: "sequential",
      execute: async (_id, params) => {
        const result = await diagrams.drawSequenceDiagram(
          DrawSequenceDiagramRequestSchema.parse({ schemaVersion: 1, ...params }),
        );
        attach(result);
        return json(result);
      },
    }),
  ];
}

const MCP_TOOL_SEARCH = "mcp_tool_search";

/**
 * The tools his connected MCP servers offer (ADR 0109), registered the same way
 * the browser's are: everything the lane may reach is registered, only the
 * useful few start active, and the rest are found by searching.
 *
 * The narrowing is the point. A tracker's server alone advertises dozens of
 * tools, and an active tool is described in the prompt on *every* turn — so
 * registering them all active would tax every "hey clankie" in a voice channel
 * for capabilities that turn never uses.
 */
export function mcpExtension(deps: CaptainDeps, lane: CaptainSessionLaneV2): InlineExtension {
  return {
    name: "captain-mcp",
    hidden: true,
    async factory(pi) {
      const catalog = await deps.mcp.catalog(lane);
      if (catalog.length === 0) return;

      const registeredNames = new Set<string>();
      for (const tool of catalog) {
        registeredNames.add(tool.qualifiedName);
        pi.registerTool({
          name: tool.qualifiedName,
          label: `${tool.server}: ${tool.name}`,
          description: tool.description,
          parameters: tool.inputSchema as TSchema,
          executionMode: "sequential",
          execute: async (_id, params) => {
            const result = await deps.mcp.call({
              lane,
              server: tool.server,
              tool: tool.name,
              arguments: (params ?? {}) as Record<string, unknown>,
            });
            // A server's own error is the model's to react to, so it is raised
            // rather than returned as a successful-looking payload.
            if (result.outcome === "ok" && result.isError) {
              throw new Error(result.content || `${tool.qualifiedName} failed`);
            }
            return json(result);
          },
        });
      }

      pi.registerTool({
        name: MCP_TOOL_SEARCH,
        label: "Find connected-service tools",
        description:
          "Find and enable tools on his connected services that are not already active. Search by task, " +
          "such as projects, cycles, documents, or labels. Use this before saying a service cannot do something.",
        parameters: Type.Object({
          query: Type.String({ minLength: 1, maxLength: 200 }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
        }),
        executionMode: "sequential",
        execute: async (_id, params) => {
          const terms = params.query
            .toLowerCase()
            .split(/[^a-z0-9]+/u)
            .filter(Boolean);
          const matches = catalog
            .filter((tool) => {
              const haystack = `${tool.server} ${tool.name} ${tool.description}`.toLowerCase();
              return terms.every((term) => haystack.includes(term));
            })
            .slice(0, params.limit ?? 5)
            .map((tool) => tool.qualifiedName);
          const active = pi.getActiveTools();
          const added = matches.filter((name) => !active.includes(name));
          if (added.length > 0) pi.setActiveTools([...active, ...added]);
          return json({ matches, added });
        },
      });

      pi.on("session_start", () => {
        const keep = pi.getActiveTools().filter((name) => !registeredNames.has(name));
        const initial = catalog.filter((tool) => tool.initial).map((tool) => tool.qualifiedName);
        pi.setActiveTools([...new Set([...keep, ...initial, MCP_TOOL_SEARCH])]);
      });
    },
  };
}

const INITIAL_BROWSER_TOOLS = new Set([
  "agent_browser_open",
  "agent_browser_read",
  "agent_browser_snapshot",
  "agent_browser_click",
  "agent_browser_fill",
  "agent_browser_screenshot",
  "agent_browser_get_url",
]);
const BROWSER_TOOL_SEARCH = "browser_tool_search";

/** Register the live browser catalog once, then reveal uncommon tools only when searched for. */
export function browserExtension(deps: CaptainDeps, turn: TurnContext): InlineExtension {
  return {
    name: "captain-browser",
    hidden: true,
    async factory(pi) {
      const catalog = await deps.browser.catalog();
      if (!catalog.available || catalog.tools.length === 0) {
        pi.registerTool({
          name: "browser_unavailable",
          label: "Browser status",
          description: "Report why the browser is unavailable instead of pretending you chose not to browse.",
          parameters: Type.Object({}),
          execute: async () =>
            json({ available: false, reason: catalog.reason ?? "the browser host reported no tools" }),
        });
        return;
      }

      const registeredNames = new Set<string>();
      for (const tool of catalog.tools) {
        const name = `browser_${tool.name}`;
        registeredNames.add(name);
        pi.registerTool({
          name,
          label: `Browser: ${tool.name}`,
          description: tool.description,
          parameters: (tool.inputSchema ?? Type.Object({})) as TSchema,
          executionMode: "sequential",
          execute: async (_id, params) => {
            const result = await deps.browser.call({
              schemaVersion: 1,
              tool: tool.name,
              arguments: (params ?? {}) as Record<string, unknown>,
            });
            if (result.outcome === "ok" && result.isError) {
              throw new Error(result.content || `${tool.name} failed`);
            }
            if (result.outcome === "ok" && result.artifacts.length > 0) {
              const artifact = result.artifacts.at(-1);
              if (artifact !== undefined) {
                turn.media = { artifactRef: artifact.artifactRef, filename: artifact.filename };
              }
            }
            return json(result);
          },
        });
      }

      pi.registerTool({
        name: BROWSER_TOOL_SEARCH,
        label: "Find browser tools",
        description:
          "Find and enable browser capabilities that are not in the small default set. Search by task, such as tabs, cookies, console errors, network requests, accessibility, viewport, or recording.",
        parameters: Type.Object({
          query: Type.String({ minLength: 1, maxLength: 200 }),
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
        }),
        executionMode: "sequential",
        execute: async (_id, params) => {
          const terms = params.query
            .toLowerCase()
            .split(/[^a-z0-9]+/u)
            .filter(Boolean);
          const matches = catalog.tools
            .filter((tool) => {
              const haystack =
                `${tool.name.replace(/^agent_browser_/u, "")} ${tool.description}`.toLowerCase();
              return terms.every((term) => haystack.includes(term));
            })
            .slice(0, params.limit ?? 5)
            .map((tool) => `browser_${tool.name}`);
          const active = pi.getActiveTools();
          const added = matches.filter((name) => !active.includes(name));
          if (added.length > 0) pi.setActiveTools([...active, ...added]);
          return json({ matches, added });
        },
      });

      pi.on("session_start", () => {
        const keep = pi.getActiveTools().filter((name) => !registeredNames.has(name));
        const initial = catalog.tools
          .filter((tool) => INITIAL_BROWSER_TOOLS.has(tool.name))
          .map((tool) => `browser_${tool.name}`);
        pi.setActiveTools([...new Set([...keep, ...initial, BROWSER_TOOL_SEARCH])]);
      });
    },
  };
}
