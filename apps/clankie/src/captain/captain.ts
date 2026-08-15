import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  personaInstructions,
  SettingsStore,
  type ClankieSettings,
  type PersonaRegister,
} from "@clankie/settings";
import {
  CAPTAIN_SILENT_REPLY_SENTINEL,
  type CaptainChannelTurnResult,
  type CaptainSessionLaneV2,
  type DiscordPresenceChannelTurnRequest,
  type OperatorConversationEventBody,
  type OperatorConversationServiceRequest,
  type OperatorConversationServiceResult,
} from "@clankie/protocol";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { ConversationStore } from "./conversations.ts";
import type { CaptainDeps, ResolvedAttachment } from "./deps.ts";
import { normalizeDiscordTurn } from "./discord-turn.ts";
import { LaneLog } from "./lane-log.ts";
import { createCaptainModelRuntime, type CaptainModelRuntime } from "./model.ts";
import type { CaptainPort, LaneObservation } from "./port.ts";
import { browserTools, captainTools, type TurnMediaCapture } from "./tools.ts";

const REGISTER_FOR_LANE: Readonly<Record<CaptainSessionLaneV2, PersonaRegister>> = {
  operator: "operator",
  discord_voice: "social",
  discord_presence: "social",
  gameplay: "gameplay",
};

export interface CaptainOptions {
  /** Repo root: instructions.md lives here, skills are discovered here. */
  readonly repoRoot: string;
  /** Durable captain state (sessions, lane logs, conversations). Default ~/.clankie/captain. */
  readonly stateDir: string;
}

interface LaneSession {
  readonly session: AgentSession;
  readonly capture: TurnMediaCapture;
  lastAssistantText: string;
  turnCounter: number;
}

/**
 * The captain on pi. Sessions are pi's: durable JSONL trees for the operator
 * conversations and voice channels, one-shot in-memory sessions for bounded
 * Discord text turns (the channel history arrives with each request, so a
 * durable transcript would only duplicate the untrusted room). The persona
 * still comes from owner-authored settings, never from the caller.
 */
export function createCaptain(deps: CaptainDeps, options: CaptainOptions): CaptainPort {
  const laneLog = new LaneLog(join(options.stateDir, "lanes"));
  const sessions = new Map<string, Promise<LaneSession>>();
  let settingsCache: Promise<ClankieSettings> | undefined;
  let modelRuntime: Promise<CaptainModelRuntime> | undefined;

  const settings = (): Promise<ClankieSettings> => (settingsCache ??= new SettingsStore().load());
  const runtime = (): Promise<CaptainModelRuntime> =>
    (modelRuntime ??= createCaptainModelRuntime(options.repoRoot));

  async function systemPrompt(lane: CaptainSessionLaneV2): Promise<string> {
    const identity = readFileSync(join(import.meta.dirname, "instructions.md"), "utf8");
    const persona = personaInstructions((await settings()).persona, REGISTER_FOR_LANE[lane]);
    return `${identity}\n\n${persona}`;
  }

  async function buildSession(
    lane: CaptainSessionLaneV2,
    sessionManager: SessionManager,
  ): Promise<LaneSession> {
    const capture: TurnMediaCapture = {};
    const { runtime: models, resolveModel } = await runtime();
    const loader = new DefaultResourceLoader({
      cwd: options.repoRoot,
      agentDir: getAgentDir(),
      systemPrompt: await systemPrompt(lane),
      noExtensions: true,
      noPromptTemplates: true,
      additionalSkillPaths: [join(options.repoRoot, ".agents", "skills")],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: options.repoRoot,
      model: await resolveModel(),
      modelRuntime: models,
      customTools: [...captainTools(deps, capture, laneLog, lane), ...(await browserTools(deps, capture))],
      resourceLoader: loader,
      sessionManager,
      // Coding tools (read/bash/edit/write) run unsandboxed as the service
      // user. Only the operator's own lane gets them; a lane fed by untrusted
      // Discord input keeps the authored tool bank and nothing that touches
      // the filesystem — the framing labels untrusted text, but a tools list
      // is a boundary and a prompt is not.
      ...(lane === "operator" ? {} : { noTools: "builtin" as const }),
    });
    const laneSession: LaneSession = { session, capture, lastAssistantText: "", turnCounter: 0 };
    session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        laneSession.lastAssistantText = assistantText(event.message);
      }
    });
    return laneSession;
  }

  function durableSession(key: string, lane: CaptainSessionLaneV2, dir: string): Promise<LaneSession> {
    const existing = sessions.get(key);
    if (existing !== undefined) return existing;
    const created = (async () => {
      let manager: SessionManager;
      try {
        manager = SessionManager.continueRecent(options.repoRoot, dir);
      } catch {
        manager = SessionManager.create(options.repoRoot, dir);
      }
      return buildSession(lane, manager);
    })();
    sessions.set(key, created);
    created.catch(() => sessions.delete(key));
    return created;
  }

  const conversations = new ConversationStore(
    join(options.stateDir, "conversations"),
    async (conversationId, message, publish) => {
      const lane = await durableSession(
        `operator:${conversationId}`,
        "operator",
        join(options.stateDir, "conversations", conversationId, "pi"),
      );
      lane.capture.media = undefined;
      const unsubscribe = lane.session.subscribe((event) => {
        if (event.type === "tool_execution_start") {
          publish({ type: "tool", toolCallId: event.toolCallId, name: event.toolName, phase: "started" });
        } else if (event.type === "tool_execution_end") {
          publish({ type: "tool", toolCallId: event.toolCallId, name: event.toolName, phase: "completed" });
        }
      });
      try {
        await laneLog.append("operator", conversationId, {
          at: new Date().toISOString(),
          kind: "heard",
          text: message,
        });
        await lane.session.prompt(message, { expandPromptTemplates: false });
        const text = lane.lastAssistantText.trim();
        publish({ type: "message", role: "captain", text, streaming: false });
        await laneLog.append("operator", conversationId, {
          at: new Date().toISOString(),
          kind: "said",
          text,
        });
      } finally {
        unsubscribe();
      }
    },
  );

  // One turn at a time per durable session: a second voice message in the
  // same channel queues behind the first instead of racing pi's prompt() and
  // cross-wiring lastAssistantText/capture between overlapping turns.
  const turnChains = new Map<string, Promise<unknown>>();

  async function runDiscordTurn(
    lane: LaneSession,
    normalized: Awaited<ReturnType<typeof normalizeDiscordTurn>>,
    deliveryId: string,
  ): Promise<CaptainChannelTurnResult> {
    lane.capture.media = undefined;
    lane.turnCounter += 1;
    const turnId = `turn-${lane.turnCounter}-${deliveryId}`;
    await laneLog.append(normalized.lane, normalized.targetId, {
      at: new Date().toISOString(),
      kind: "heard",
      text: normalized.heard,
    });
    try {
      await lane.session.prompt(normalized.prompt, {
        expandPromptTemplates: false,
        images: normalized.images.map(toImageContent),
      });
    } catch {
      return { state: "failed", turnId, code: "captain_session_failed" };
    } finally {
      if (!normalized.durable) lane.session.dispose();
    }
    const message = lane.lastAssistantText.trim();
    if (message.length === 0) {
      return {
        state: "failed",
        captainSessionId: normalized.sessionKey,
        turnId,
        code: "captain_response_missing",
      };
    }
    // Matched on the trimmed whole message, never a substring: a reply that
    // merely quotes the sentinel is still a reply, and silencing it would let
    // anyone who says the token in a channel mute him.
    if (message === CAPTAIN_SILENT_REPLY_SENTINEL) {
      return { state: "silent", captainSessionId: normalized.sessionKey, turnId };
    }
    await laneLog.append(normalized.lane, normalized.targetId, {
      at: new Date().toISOString(),
      kind: "said",
      text: message,
    });
    return {
      state: "settled",
      captainSessionId: normalized.sessionKey,
      turnId,
      response: message,
      ...(lane.capture.media === undefined ? {} : { media: lane.capture.media }),
    };
  }

  return {
    async submitDiscordTurn(request: DiscordPresenceChannelTurnRequest): Promise<CaptainChannelTurnResult> {
      const normalized = await normalizeDiscordTurn(request, deps);
      if (!normalized.durable) {
        const lane = await buildSession(normalized.lane, SessionManager.inMemory(options.repoRoot));
        return runDiscordTurn(lane, normalized, request.deliveryId);
      }
      const key = normalized.sessionKey;
      const run = (turnChains.get(key) ?? Promise.resolve()).then(async () => {
        const lane = await durableSession(
          key,
          normalized.lane,
          join(options.stateDir, "voice", encodeURIComponent(key)),
        );
        return runDiscordTurn(lane, normalized, request.deliveryId);
      });
      turnChains.set(
        key,
        run.catch(() => undefined),
      );
      return run;
    },

    serveOperatorConversation(
      request: OperatorConversationServiceRequest,
    ): Promise<OperatorConversationServiceResult> {
      return conversations.serve(request);
    },

    async observeLanes(): Promise<readonly LaneObservation[]> {
      return laneLog.list();
    },

    voiceLaneInstructions(): string {
      return (
        "You are present in a Discord voice channel. You hear only opted-in participants and you speak " +
        "aloud: keep replies short, conversational, and free of markdown, links, file paths, or anything " +
        "that only makes sense on a screen. You are a participant in the room, not an assistant on call."
      );
    },

    async close(): Promise<void> {
      await conversations.close();
      for (const pending of sessions.values()) {
        try {
          (await pending).session.dispose();
        } catch {
          // Closing is best-effort; a session that failed to build has nothing to dispose.
        }
      }
      sessions.clear();
    },
  };
}

function assistantText(message: { content?: unknown }): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text",
    )
    .map((part) => part.text)
    .join("");
}

function toImageContent(attachment: ResolvedAttachment): ImageContent {
  const comma = attachment.dataUrl.indexOf(",");
  return {
    type: "image",
    data: comma === -1 ? attachment.dataUrl : attachment.dataUrl.slice(comma + 1),
    mimeType: attachment.mediaType,
  };
}

export { type OperatorConversationEventBody };
