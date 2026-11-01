import { VOICE_JOIN_REQUEST_MAX_CHARS } from "@clankie/discord-presence-core";
import { CAPTAIN_SILENT_REPLY_SENTINEL, type CaptainSessionLaneV2 } from "@clankie/protocol";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { CaptainDeps } from "./deps.ts";
import { toolJson as json, turnActor, type TurnContext } from "./tools.ts";

/**
 * The persona's Discord body tools (ADR 0328): voice membership, grounded
 * social actions on the turn's message, the connected server's REST and
 * project mirrors, and the DJ desk. The captain reaches them through
 * `CaptainDeps.personaTools`, which the composition root fills only while the
 * persona is on; each group still leaves itself out when its body client is
 * absent, as on a hosted body.
 */
export function discordCaptainTools(
  deps: CaptainDeps,
  turn: TurnContext,
  lane: CaptainSessionLaneV2,
): ToolDefinition[] {
  return [
    ...discordVoicePresenceTools(deps, turn, lane),
    ...discordActionTools(deps, turn, lane),
    ...discordServerTools(deps, turn, lane),
    ...discordMusicTools(deps, turn, lane),
  ];
}

/**
 * The consent situation a join lands him in — not a line about it.
 *
 * A finished disclosure sentence once became a cue card that he read into a
 * group chat, placeholder and all. Describe consent and arrival choices as
 * context, leaving whether and where to speak to him (ADR 0062).
 */
const VOICE_JOIN_CONSENT_STATE =
  "When actorCanBeHeard is false, nothing they say reaches you at all until they run /clankie voice-consent opt-in. " +
  "When it is true, you are transcribing them from the moment you arrive. When transcriptLoggingEnabled is true, " +
  "exact consented speech and speaker attribution are also retained in the owner's private local development log; " +
  "when false, exact speech is not retained locally. Both are the owner's own settings, and so is who tells the " +
  "room: people either opted in themselves through the slash command, which told them, or are in a room whose " +
  "owner chose presence as consent and handles telling people. None of it is news you owe on arrival; " +
  "you are someone joining a call. If anyone asks what you hear or keep, answer plainly. " +
  "A text reply after joining is optional: you can reply here, or use " +
  `${CAPTAIN_SILENT_REPLY_SENTINEL} to send nothing here. Your arrival also gives your voice side ` +
  "the room and invitation context and a turn, so you can greet in voice instead or stay quiet there too.";

function discordVoicePresenceTools(
  deps: CaptainDeps,
  turn: TurnContext,
  lane: CaptainSessionLaneV2,
): ToolDefinition[] {
  if (!lane.startsWith("discord_") && lane !== "operator") return [];
  const voice = deps.discordVoicePresence;
  // No Discord body in this install (a hosted body's loadout): nothing to join.
  if (voice === undefined) return [];
  const call = async (action: "join" | "leave") => {
    if (voice === undefined) {
      return json({ action: action === "join" ? "join_refused" : "leave_refused", reason: "failed" });
    }
    if (lane === "operator") return json(await voice[action]({}, turn.bodyIdentity));
    const guildId = turn.guildId;
    const actorId = turn.actorId;
    if (guildId === undefined || actorId === undefined) {
      return json({ action: action === "join" ? "join_refused" : "leave_refused", reason: "failed" });
    }
    return json(
      await voice[action](
        {
          guildId,
          actorId,
          ...(action !== "join" || turn.requestText === undefined
            ? {}
            : { requestText: turn.requestText.slice(0, VOICE_JOIN_REQUEST_MAX_CHARS) }),
        },
        turn.bodyIdentity,
      ),
    );
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
          "ambiguous means they are in more than one, no_owner means nobody is configured as the owner, " +
          "provider_refused means the voice provider refused to hear (providerCode names why, such as " +
          "credit_balance_exhausted for an account out of credit). " +
          "On success, actorCanBeHeard says whether the owner can be heard under the room's current consent policy. " +
          VOICE_JOIN_CONSENT_STATE
        : "Join the Discord voice channel the person speaking to you is in now. Use this when they ask you to " +
          "join, hop in, come talk, or otherwise enter their call. The live Discord body—not you—resolves the " +
          "channel and enforces authority and allowlists. A refusal reason is a fact to explain, not a reason to retry; " +
          "provider_refused means the voice provider refused to hear, and providerCode names why. " +
          "On success, actorCanBeHeard says whether the speaker can be heard under the room's current consent policy. " +
          VOICE_JOIN_CONSENT_STATE,
      parameters: Type.Object({}),
      execute: () => call("join"),
    }),
    defineTool({
      name: "voice_leave",
      label: "Leave voice",
      description:
        "Leave your active Discord voice channel when you decide to end your stay. The live " +
        "Discord body enforces authority and prevents one server from ending a call in another.",
      parameters: Type.Object({}),
      execute: () => call("leave"),
    }),
  ];
}

function discordServerTools(
  deps: CaptainDeps,
  turn: TurnContext,
  lane: CaptainSessionLaneV2,
): ToolDefinition[] {
  if (deps.discordActions === undefined || (lane !== "operator" && turn.shell !== true)) return [];
  return [
    defineTool({
      name: "discord_server_action",
      label: "Manage connected Discord server",
      description:
        "Use native Discord REST in your connected server. In admin role you have full rein over channels, " +
        "categories, placement, archives, roles, webhooks, and members, without asking permission. " +
        "Never delete the server or transfer ownership. Use /guilds/@server for the connected server; " +
        "use actual channel, role, webhook, and member IDs from your directory or GET reads. " +
        "Examples: POST /guilds/@server/channels with {name,type:0|4|15,parent_id?}; " +
        "PATCH /channels/<id> with {parent_id} or {archived:true} for a thread; " +
        "PATCH /guilds/@server/channels with an array of {id,position,parent_id}; " +
        "POST /channels/<forum>/threads with {name,message:{content}}. " +
        "Participant role can only publish projection messages to its configured channel through this tool; " +
        "your ordinary conversation tools still follow Discord permissions. This grants no machine access. " +
        "The body checks each resource belongs to the server and redacts credential-bearing response fields.",
      parameters: Type.Object({
        method: Type.Union([
          Type.Literal("GET"),
          Type.Literal("POST"),
          Type.Literal("PATCH"),
          Type.Literal("PUT"),
          Type.Literal("DELETE"),
        ]),
        path: Type.String({ minLength: 1, maxLength: 512 }),
        body: Type.Optional(
          Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Array(Type.Unknown())]),
        ),
      }),
      execute: (callId, input) =>
        deps
          .discordActions!.execute({
            method: input.method,
            path: input.path,
            ...(input.body === undefined ? {} : { body: input.body }),
            action: "server_action",
            callId,
            source: lane === "operator" ? "operator" : "discord",
            ...(turn.guildId === undefined ? {} : { sourceGuildId: turn.guildId }),
          } as Parameters<NonNullable<CaptainDeps["discordActions"]>["execute"]>[0])
          .then(json),
    }),
    ...(deps.discordTracking === undefined
      ? []
      : [
          defineTool({
            name: "discord_tracking_project",
            label: "Choose project mirror",
            description:
              "Choose a tracked project's Discord representation before its first event: a channel, or a forum with one post per issue. Use your judgment. Existing mirrors refuse a different representation to preserve their history. This chooses representation; the owner's tracking level still decides which events are posted.",
            parameters: Type.Object({
              projectId: Type.String({ minLength: 1, maxLength: 128 }),
              representation: Type.Union([Type.Literal("channel"), Type.Literal("forum")]),
            }),
            execute: async (_callId, input) => {
              const settings = await deps.discordSettings?.();
              if (
                !settings ||
                (lane === "operator"
                  ? !Object.values(settings.guilds).some((policy) => policy.role === "admin")
                  : !turn.guildId || settings.guilds[turn.guildId]?.role !== "admin")
              )
                return json({
                  ok: false,
                  message: "Project mirrors require the admin role in the connected server.",
                });
              try {
                await deps.discordTracking!.configureProject(input.projectId, input.representation);
                return json({ ok: true, message: "Project mirror representation saved." });
              } catch (error) {
                return json({
                  ok: false,
                  message: error instanceof Error ? error.message : "Project mirror unavailable.",
                });
              }
            },
          }),
        ]),
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
            name: "send_text_update",
            label: "Send text update",
            description:
              "Post one short text update to this Discord channel immediately, without ending your turn. This is not voice speech, and your real text reply still posts when you finish. Use your social judgment: post one only when someone is actually waiting on work and a meaningful delay would otherwise leave them hanging. An unsolicited link or task you chose to inspect on your own does not need an update; work quietly. If an update is warranted, say what you are going off to do, in your own voice, and then go do it. Do not use it to pad a turn you can just answer.",
            parameters: Type.Object({
              text: Type.String({
                minLength: 1,
                maxLength: 600,
                description: "What to say now, in your own voice. One or two sentences.",
              }),
            }),
            execute: (callId, params) =>
              deps
                .discordActions!.execute({
                  action: "send_text_update",
                  ...context(callId),
                  text: params.text,
                })
                .then(json),
          }),
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
      parameters: Type.Object({
        surface: Type.Optional(Type.Union([Type.Literal("gba_emulator"), Type.Literal("minecraft")])),
      }),
      execute: (callId, input) => {
        const grounded = context(callId);
        if (grounded.guildId === undefined) {
          return Promise.resolve(json({ ok: false, message: "Voice needs a server." }));
        }
        return deps
          .discordActions!.execute({
            action: "watch_start",
            ...grounded,
            guildId: grounded.guildId,
            ...(input.surface === undefined ? {} : { surface: input.surface }),
          })
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

function discordMusicTools(
  deps: CaptainDeps,
  turn: TurnContext,
  lane: CaptainSessionLaneV2,
): ToolDefinition[] {
  const music = deps.discordMusic;
  // No Discord body in this install (a hosted body's loadout): no music desk.
  if (music === undefined) return [];
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
        "Use this when someone wants a song, a track, or YouTube — not pokeagent_join_mmo (that is Pokemon).",
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
