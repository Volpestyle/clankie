import type { CaptainSessionLaneV2, CaptainTurnMedia } from "@clankie/protocol";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import type { CaptainDeps } from "./deps.ts";
import type { LaneLog } from "./lane-log.ts";
import { startPlay, stopPlay } from "./play.ts";

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
}

/** Room key, stable across a room's turns and distinct across rooms. */
export function roomKey(lane: string, targetId: string): string {
  return `${lane}:${targetId}`;
}

function json(value: unknown): { content: [{ type: "text"; text: string }]; details: unknown } {
  return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
}

/**
 * The captain's authored tool bank. Coding tools (read/bash/edit/write) are
 * pi built-ins and are not defined here. Herdr leadership goes through bash +
 * the herdr skill, not bespoke tools.
 */
export function captainTools(
  deps: CaptainDeps,
  turn: TurnContext,
  laneLog: LaneLog,
  lane: CaptainSessionLaneV2,
): ToolDefinition[] {
  const playPorts = {
    submitEmbodimentIntent: deps.embodiment.submitIntent,
    getEmbodimentSession: deps.embodiment.getSession,
    getLiveEmbodimentSession: deps.embodiment.getLiveSession,
  };
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
      execute: async (_id, params) => {
        const result = await deps.media.generateVideo({ schemaVersion: 1, ...params }, turn.room);
        if (result.outcome === "ok")
          turn.media = { artifactRef: result.artifactRef, filename: result.filename };
        return json(result);
      },
    }),
    defineTool({
      name: "start_play",
      label: "Start playing",
      description:
        "Start playing a game on your own body, live on the activity watch surface. Currently playable: " +
        "pokemon-firered and pokemon-emerald. The session resumes from your latest checkpoint and keeps going " +
        "until someone asks you to stop; people can watch. 'started' means you are playing; 'start_refused' names " +
        "a reason you can say out loud (body_held means someone else is already driving your body); 'pending' " +
        "means it is still spinning up — say so, never claim to be playing yet.",
      parameters: Type.Object({
        environmentId: Type.Union([Type.Literal("pokemon-firered"), Type.Literal("pokemon-emerald")], {
          default: "pokemon-firered",
        }),
        requestedBy: Type.String({
          minLength: 1,
          maxLength: 200,
          description: "The asker's id; 'owner' for the operator.",
        }),
      }),
      execute: async (_id, params) =>
        json(
          await startPlay(playPorts, {
            environmentId: params.environmentId,
            originLane: lane,
            requestedBy: params.requestedBy,
          }),
        ),
    }),
    defineTool({
      name: "stop_play",
      label: "Stop playing",
      description:
        "Stop the live play session on your body. The result is what actually happened; a session that was " +
        "already stopped is not an error worth apologising for.",
      parameters: Type.Object({
        requestedBy: Type.String({ minLength: 1, maxLength: 200 }),
      }),
      execute: async (_id, params) =>
        json(await stopPlay(playPorts, { originLane: lane, requestedBy: params.requestedBy })),
    }),
    defineTool({
      name: "observe_current_activity",
      label: "Look at your screen",
      description:
        "Look at what is currently on your own screen — the live play session's latest frame and status. " +
        "Use it when someone asks what you are doing or how the run is going.",
      parameters: Type.Object({}),
      execute: async () => json(await deps.activity.current()),
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
        "your body, recent voice stays. Read it before answering questions about yourself.",
      parameters: Type.Object({}),
      execute: async () => {
        const [live, sessions, possession, voiceHistory, renders] = await Promise.all([
          deps.embodiment.getLiveSession(),
          deps.presence.listSessions(),
          deps.embodiment.getPossession(),
          deps.presence.listVoiceHistory(5),
          // Only this room's renders: what he was asked to make elsewhere is
          // not this room's business, same rule as `observe_room`.
          turn.room === undefined ? [] : deps.media.finishedRenders(turn.room),
        ]);
        return json({
          liveSession: live,
          presenceSessions: sessions,
          bodyPossession: possession,
          voiceHistory,
          finishedRenders: renders,
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
        lane: Type.String({ minLength: 1, maxLength: 100 }),
        episode: Type.String({ minLength: 1, maxLength: 2000 }),
      }),
      execute: async (_id, params) => {
        await deps.memory.appendEpisode(params.lane, params.episode);
        return json({ remembered: true });
      },
    }),
  ];
}

/**
 * The browser, resolved from the live catalog when a session is built (ADR
 * 0082): the agent-browser host names the tools, this file never enumerates
 * them. When the host is unreachable he gets one honest tool that says so,
 * instead of a silently empty surface.
 */
export async function browserTools(deps: CaptainDeps, turn: TurnContext): Promise<ToolDefinition[]> {
  const catalog = await deps.browser.catalog();
  if (!catalog.available || catalog.tools.length === 0) {
    return [
      defineTool({
        name: "browser_unavailable",
        label: "Browser status",
        description:
          "Report why your browser is not reachable right now. If this is the only browser tool you have, " +
          "say you cannot browse and why, rather than implying you chose not to.",
        parameters: Type.Object({}),
        execute: async () =>
          json({ available: false, reason: catalog.reason ?? "the browser host reported no tools" }),
      }),
    ];
  }
  return catalog.tools.map((tool) =>
    defineTool({
      name: `browser_${tool.name}`,
      label: `Browser: ${tool.name}`,
      description: tool.description,
      // The MCP server's own JSON Schema, passed through so the model sees the
      // arguments the tool actually takes. TypeBox validates plain JSON Schema.
      parameters: (tool.inputSchema ?? Type.Object({})) as TSchema,
      execute: async (_id, params) => {
        const result = await deps.browser.call({
          schemaVersion: 1,
          tool: tool.name,
          arguments: (params ?? {}) as Record<string, unknown>,
        });
        if (result.outcome === "ok" && result.artifacts.length > 0) {
          const artifact = result.artifacts.at(-1);
          if (artifact !== undefined) {
            turn.media = { artifactRef: artifact.artifactRef, filename: artifact.filename };
          }
        }
        return json(result);
      },
    }),
  );
}
