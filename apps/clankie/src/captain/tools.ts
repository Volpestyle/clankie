import {
  CAPTAIN_EPISODE_SUMMARY_MAX,
  DrawErDiagramRequestSchema,
  DrawSequenceDiagramRequestSchema,
  type CaptainSessionLaneV2,
  type CaptainTurnMedia,
  type DrawDiagramResult,
  isAttachableTurnMediaRef,
} from "@clankie/protocol";
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
  /** Host-stamped room target; models never choose episode provenance. */
  targetId?: string | undefined;
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
 * pi built-ins and are not defined here. They attach to the operator console
 * and to Discord text turns whose actor is on `systemActorUserIds`. Herdr
 * leadership goes through bash + the herdr skill, not bespoke tools.
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
    ...diagramTools(deps, turn),
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
      name: "observe_share",
      label: "Look at a screen share",
      description:
        "Look at a Discord screen share in a voice channel you can see. Returns a still of the share when " +
        "the lab user body is watching it. If someone is sharing but you have no still, say that — do not invent " +
        "what is on their screen. Use it when someone asks what is on the share, what they are looking at, or " +
        "what is on screen in the call.",
      parameters: Type.Object({}),
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
                ? "someone is sharing but ClankVox is not configured, so you cannot see the picture"
                : "someone is sharing but you do not have a still yet",
          });
        }
        if (frame.artifactRef !== undefined && isAttachableTurnMediaRef(frame.artifactRef)) {
          turn.media = { artifactRef: frame.artifactRef, filename: `share-${frame.userId}.jpg` };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                outcome: "frame",
                streams: observation.streams,
                width: frame.width,
                height: frame.height,
                userId: frame.userId,
              }),
            },
            { type: "image" as const, data: frame.jpegBase64, mimeType: "image/jpeg" },
          ],
          details: { outcome: "frame", streams: observation.streams },
        };
      },
    }),
    defineTool({
      name: "observe_current_activity",
      label: "Look at your screen",
      description:
        "Look at what is currently on your own screen — the live play session's latest frame and status. " +
        "Use it when someone asks what you are doing, what is on screen, or how the run is going. " +
        "When a still is available it arrives as an image; say what you actually see.",
      parameters: Type.Object({}),
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
      name: "recall_play",
      label: "Recall this playthrough",
      description:
        "Read this playthrough's story so far: where you are, what you are after, and the last few moments " +
        "you judged worth a remark. Not the raw journal. Use it when someone asks how you got here or what " +
        "has happened in the run. Say when you are not playing rather than inventing a playthrough.",
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
        visibility: Type.Optional(Type.Union([Type.Literal("shareable"), Type.Literal("operator_private")])),
      }),
      execute: async (_id, params) => {
        if (turn.targetId === undefined) throw new Error("Turn room attribution is unavailable");
        await deps.memory.appendEpisode({
          lane,
          targetId: turn.targetId,
          summary: params.summary,
          ...(params.visibility === undefined ? {} : { visibility: params.visibility }),
        });
        return json({ remembered: true });
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
              Type.Union(
                [
                  Type.Literal("black"),
                  Type.Literal("grey"),
                  Type.Literal("blue"),
                  Type.Literal("green"),
                  Type.Literal("yellow"),
                  Type.Literal("orange"),
                  Type.Literal("red"),
                  Type.Literal("violet"),
                ],
                { description: "Group related tables by colour." },
              ),
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
