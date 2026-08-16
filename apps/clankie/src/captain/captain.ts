import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  personaInstructions,
  resolveDiscordSettings,
  SettingsStore,
  type ClankieSettings,
  type PersonaRegister,
} from "@clankie/settings";
import {
  CAPTAIN_SILENT_REPLY_SENTINEL,
  OPERATOR_CONVERSATION_TOOL_DETAIL_MAX,
  type CaptainChannelTurnResult,
  type CaptainSessionLaneV2,
  type DiscordPresenceChannelTurnRequest,
  type ObservableCaptainLane,
  type OperatorConversationEventBody,
  type OperatorConversationServiceRequest,
  type OperatorConversationServiceResult,
} from "@clankie/protocol";
import { sanitizeForSupportBundle } from "@clankie/observability";
import type { ImageContent } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type AgentSession,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { ConversationStore } from "./conversations.ts";
import { readHerdrSessionCensus, type HerdrSessionCensus } from "./herdr-census.ts";
import { operatorPromptWithHerdrSeat } from "./herdr-seat.ts";
import type { CaptainDeps, ResolvedAttachment } from "./deps.ts";
import { normalizeDiscordTurn } from "./discord-turn.ts";
import { LaneLog } from "./lane-log.ts";
import { createCaptainModelRuntime, type CaptainModelRuntime } from "./model.ts";
import type { CaptainPort } from "./port.ts";
import { connectionTools } from "./connect-tools.ts";
import { discordTurnHasSystemTools } from "./system-authority.ts";
import { browserTools, captainTools, roomKey, type TurnContext } from "./tools.ts";

const REGISTER_FOR_LANE: Readonly<Record<CaptainSessionLaneV2, PersonaRegister>> = {
  operator: "operator",
  discord_voice: "social",
  discord_presence: "social",
  gameplay: "gameplay",
};

const TOOL_DETAIL_TRUNCATED = "\n… truncated";
/** Whole-turn backstop; tools own their tighter deadlines and typing has its own cosmetic clock. */
export const DISCORD_TEXT_TURN_HARD_TIMEOUT_MS = 10 * 60_000;

/** Refresh bounded episodic recall as trusted context for every Pi run. */
export function captainMemoryExtension(memory: CaptainDeps["memory"], lane: CaptainSessionLaneV2) {
  return {
    name: "captain-memory",
    hidden: true,
    factory(pi) {
      pi.on("before_agent_start", async (event) => {
        const card = await memory.recallEpisodeCard(lane).catch(() => "");
        return card.length === 0 ? undefined : { systemPrompt: `${event.systemPrompt}\n\n${card}` };
      });
    },
  } satisfies InlineExtension;
}

function boundOperatorToolDetail(detail: string): string {
  if (detail.length <= OPERATOR_CONVERSATION_TOOL_DETAIL_MAX) return detail;
  return `${detail.slice(0, OPERATOR_CONVERSATION_TOOL_DETAIL_MAX - TOOL_DETAIL_TRUNCATED.length)}${TOOL_DETAIL_TRUNCATED}`;
}

/** Serialize a tool payload without letting diagnostics fail the turn that produced it. */
export function formatOperatorToolDetail(value: unknown): string {
  let detail: string;
  try {
    const sanitized = sanitizeForSupportBundle(value);
    detail = JSON.stringify(sanitized, null, 2) ?? String(sanitized);
  } catch {
    return "[tool detail could not be serialized]";
  }
  return boundOperatorToolDetail(detail);
}

/** Prefer the result text Pi gave the model over dumping Pi's transport envelope. */
export function formatOperatorToolResult(result: unknown): string {
  if (typeof result !== "object" || result === null) return formatOperatorToolDetail(result);
  const content = (result as { readonly content?: unknown }).content;
  if (!Array.isArray(content)) return formatOperatorToolDetail(result);
  const visible = content.flatMap((block): string[] => {
    if (typeof block !== "object" || block === null) return [];
    const entry = block as { readonly mimeType?: unknown; readonly text?: unknown; readonly type?: unknown };
    if (entry.type === "text" && typeof entry.text === "string") return [entry.text];
    if (entry.type === "image") {
      return [`[image${typeof entry.mimeType === "string" ? `: ${entry.mimeType}` : ""}]`];
    }
    return [];
  });
  // ponytail: show model-visible content; add tool-specific renderers if structured details need their own UI.
  return visible.length === 0
    ? formatOperatorToolDetail(result)
    : boundOperatorToolDetail(stripVTControlCharacters(visible.join("\n\n")));
}

/** Pi loads a skill through the ordinary read tool; retain that meaning for the operator UI. */
export function operatorSkillName(toolName: string, args: unknown): string | undefined {
  if (toolName !== "read" || typeof args !== "object" || args === null) return undefined;
  const fields = args as { readonly file_path?: unknown; readonly path?: unknown };
  const path = typeof fields.path === "string" ? fields.path : fields.file_path;
  if (typeof path !== "string" || basename(path) !== "SKILL.md") return undefined;
  const name = basename(dirname(path));
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name) && name.length <= 64 ? name : undefined;
}

export function resolveOperatorPrompt(
  message: string,
  skills: readonly { readonly disableModelInvocation: boolean; readonly name: string }[],
  herdrPaneId?: string,
  census?: HerdrSessionCensus,
): { readonly prompt: string; readonly skillName?: string } {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/u.exec(message);
  const token = match?.[1]?.toLowerCase();
  if (token === undefined) return { prompt: operatorPromptWithHerdrSeat(message, herdrPaneId, census) };
  const name = token.startsWith("skill:") ? token.slice("skill:".length) : token;
  const skill = skills.find((candidate) => candidate.name === name && !candidate.disableModelInvocation);
  if (skill === undefined) return { prompt: operatorPromptWithHerdrSeat(message, herdrPaneId, census) };
  const args = operatorPromptWithHerdrSeat(match?.[2]?.trim() ?? "", herdrPaneId, census).trim();
  return {
    prompt: `/skill:${skill.name}${args.length === 0 ? "" : ` ${args}`}`,
    skillName: skill.name,
  };
}

export interface CaptainOptions {
  /** Repo root: instructions.md lives here, skills are discovered here. */
  readonly repoRoot: string;
  /** Durable captain state (sessions, lane logs, conversations). Default ~/.clankie/captain. */
  readonly stateDir: string;
  /** Settings store; defaults to the owner-authored file. Reloaded per turn. */
  readonly settings?: SettingsStore;
}

interface LaneSession {
  readonly session: AgentSession;
  readonly capture: TurnContext;
  lastAssistantText: string;
  turnCounter: number;
  /** Settlement of the in-flight run, while one is active: true if it succeeded. */
  running?: Promise<boolean> | undefined;
}

/**
 * One turn against a durable lane (ADR 0091). An idle lane starts the run and
 * carries the final reply. A lane already mid-run gets the message steered
 * into the live run — pi delivers it at the next turn boundary and keeps the
 * loop alive until the queue drains — and the caller reports "absorbed" once
 * the merged run settles: the runner's reply answers everything heard, so an
 * absorbed turn must stay silent rather than double-speak.
 */
export async function runDurableTurn(
  lane: {
    readonly session: Pick<AgentSession, "isStreaming" | "prompt">;
    readonly capture: TurnContext;
    running?: Promise<boolean> | undefined;
  },
  prompt: string,
  images: ImageContent[],
): Promise<"ran" | "absorbed"> {
  for (;;) {
    const running = lane.running;
    if (running === undefined) {
      // The idle check and the prompt() call share one synchronous stretch —
      // with template expansion off pi reaches its own streaming check without
      // awaiting — so the state observed here is the state it acts on.
      lane.capture.media = undefined;
      const run = lane.session.prompt(prompt, { expandPromptTemplates: false, images });
      lane.running = run
        .then(
          () => true,
          () => false,
        )
        .finally(() => {
          lane.running = undefined;
        });
      await run;
      return "ran";
    }
    if (lane.session.isStreaming) {
      await lane.session.prompt(prompt, {
        expandPromptTemplates: false,
        streamingBehavior: "steer",
        images,
      });
      if (!(await running)) throw new Error("The run this turn was steered into failed");
      return "absorbed";
    }
    // A run is accepted but not streaming yet, or is winding down: wait for it
    // to settle and decide again.
    await running;
  }
}

/** Abort a one-shot Discord text session instead of holding its HTTP request and typing indicator forever. */
export async function runOneShotDiscordTurn(
  session: Pick<AgentSession, "abort" | "prompt">,
  prompt: string,
  images: ImageContent[],
  timeoutMs = DISCORD_TEXT_TURN_HARD_TIMEOUT_MS,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completed = await Promise.race([
      session.prompt(prompt, { expandPromptTemplates: false, images }).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(resolve, timeoutMs, false);
        timer.unref?.();
      }),
    ]);
    if (!completed) void session.abort().catch(() => undefined);
    return completed;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
  const settingsStore = options.settings ?? new SettingsStore();
  let modelRuntime: Promise<CaptainModelRuntime> | undefined;

  const settings = (): Promise<ClankieSettings> => settingsStore.load();
  const runtime = (): Promise<CaptainModelRuntime> =>
    (modelRuntime ??= createCaptainModelRuntime(options.repoRoot));

  async function systemPrompt(lane: CaptainSessionLaneV2, systemTools: boolean): Promise<string> {
    const identity = readFileSync(join(import.meta.dirname, "instructions.md"), "utf8");
    const persona = personaInstructions((await settings()).persona, REGISTER_FOR_LANE[lane]);
    const reach = systemTools
      ? [
          "",
          "# This turn",
          "You have a shell and filesystem tools this turn. `herdr` talks to the local socket from this service. When a turn names your herdr pane, you have joined that session: the agents in `<herdr_session>` are yours to lead, route, and harvest. When it names none, you are on the socket only. Never run bare `herdr-lead` from this shell — that starts a TUI in-process and hangs.",
        ].join("\n")
      : [
          "",
          "# This room",
          "You do not have a shell or filesystem tools in this room. If someone asks you to inspect herdr, run a command, or read a file, say you cannot from here. Do not imply you chose not to look.",
        ].join("\n");
    return `${identity}\n\n${persona}${reach}`;
  }

  async function buildSession(
    lane: CaptainSessionLaneV2,
    sessionManager: SessionManager,
    systemTools: boolean,
  ): Promise<LaneSession> {
    const capture: TurnContext = {};
    const { runtime: models, resolveModel } = await runtime();
    const loader = new DefaultResourceLoader({
      cwd: options.repoRoot,
      agentDir: getAgentDir(),
      systemPrompt: await systemPrompt(lane, systemTools),
      noExtensions: true,
      extensionFactories: [captainMemoryExtension(deps.memory, lane)],
      noPromptTemplates: true,
      additionalSkillPaths: [join(options.repoRoot, ".agents", "skills")],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: options.repoRoot,
      model: await resolveModel(),
      modelRuntime: models,
      customTools: [
        ...captainTools(deps, capture, laneLog, lane),
        ...connectionTools(deps, lane),
        ...(await browserTools(deps, capture)),
      ],
      resourceLoader: loader,
      sessionManager,
      // Coding tools (read/bash/edit/write) run unsandboxed as the service
      // user. The operator console always has them. A Discord text turn gets
      // them only when the trigger actor is on `systemActorUserIds` — a tools
      // list is a boundary; the framing around untrusted channel history is
      // not. Voice never does: that session is shared across speakers.
      ...(systemTools ? {} : { noTools: "builtin" as const }),
    });
    const laneSession: LaneSession = { session, capture, lastAssistantText: "", turnCounter: 0 };
    session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        laneSession.lastAssistantText = assistantText(event.message);
      }
    });
    return laneSession;
  }

  function durableSession(
    key: string,
    lane: CaptainSessionLaneV2,
    dir: string,
    systemTools: boolean,
  ): Promise<LaneSession> {
    const existing = sessions.get(key);
    if (existing !== undefined) return existing;
    const created = (async () => {
      let manager: SessionManager;
      try {
        manager = SessionManager.continueRecent(options.repoRoot, dir);
      } catch {
        manager = SessionManager.create(options.repoRoot, dir);
      }
      return buildSession(lane, manager, systemTools);
    })();
    sessions.set(key, created);
    created.catch(() => sessions.delete(key));
    return created;
  }

  const conversations = new ConversationStore(
    join(options.stateDir, "conversations"),
    async (conversationId, message, publish, seat) => {
      const lane = await durableSession(
        `operator:${conversationId}`,
        "operator",
        join(options.stateDir, "conversations", conversationId, "pi"),
        true,
      );
      lane.capture.media = undefined;
      lane.capture.room = roomKey("operator", conversationId);
      lane.capture.targetId = conversationId;
      const skillCalls = new Map<string, string>();
      const unsubscribe = lane.session.subscribe((event) => {
        if (event.type === "tool_execution_start") {
          const skillName = operatorSkillName(event.toolName, event.args);
          if (skillName !== undefined) skillCalls.set(event.toolCallId, skillName);
          publish({
            type: "tool",
            toolCallId: event.toolCallId,
            name: event.toolName,
            phase: "started",
            detail: formatOperatorToolDetail(event.args),
            ...(skillName === undefined ? {} : { skillName }),
          });
        } else if (event.type === "tool_execution_end") {
          const skillName = skillCalls.get(event.toolCallId);
          skillCalls.delete(event.toolCallId);
          publish({
            type: "tool",
            toolCallId: event.toolCallId,
            name: event.toolName,
            phase: event.isError ? "failed" : "completed",
            detail: formatOperatorToolResult(event.result),
            ...(skillName === undefined ? {} : { skillName }),
          });
        } else if (
          (event.type === "message_end" && event.message.role === "assistant") ||
          event.type === "compaction_end"
        ) {
          const usage = lane.session.getContextUsage();
          if (usage !== undefined) {
            publish({
              type: "context",
              usage: { tokens: usage.tokens, contextWindow: usage.contextWindow },
            });
          }
        }
      });
      try {
        await laneLog.append("operator", conversationId, {
          at: new Date().toISOString(),
          kind: "heard",
          text: message,
        });
        const census =
          seat?.herdrPaneId === undefined ? undefined : await readHerdrSessionCensus(seat.herdrPaneId);
        const prompt = resolveOperatorPrompt(
          message,
          lane.session.resourceLoader.getSkills().skills,
          seat?.herdrPaneId,
          census,
        );
        if (prompt.skillName !== undefined) {
          publish({
            type: "tool",
            toolCallId: `skill-${randomUUID()}`,
            name: "skill",
            phase: "completed",
            skillName: prompt.skillName,
          });
        }
        // The resource loader disables discovered extensions and prompt templates;
        // exact, loaded operator skills are the only input allowed to reach Pi expansion.
        await lane.session.prompt(prompt.prompt, {
          expandPromptTemplates: prompt.skillName !== undefined,
        });
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

  async function runDiscordTurn(
    lane: LaneSession,
    normalized: Awaited<ReturnType<typeof normalizeDiscordTurn>>,
    deliveryId: string,
  ): Promise<CaptainChannelTurnResult> {
    lane.turnCounter += 1;
    lane.capture.room = roomKey(normalized.lane, normalized.targetId);
    lane.capture.targetId = normalized.targetId;
    lane.capture.actorId = normalized.actorId;
    lane.capture.guildId = normalized.guildId;
    lane.capture.channelId = normalized.channelId;
    lane.capture.messageId = normalized.messageId;
    const turnId = `turn-${lane.turnCounter}-${deliveryId}`;
    await laneLog.append(normalized.lane, normalized.targetId, {
      at: new Date().toISOString(),
      kind: "heard",
      text: normalized.heard,
    });
    let role: "ran" | "absorbed" = "ran";
    try {
      if (normalized.durable) {
        role = await runDurableTurn(lane, normalized.prompt, normalized.images.map(toImageContent));
      } else {
        const completed = await runOneShotDiscordTurn(
          lane.session,
          normalized.prompt,
          normalized.images.map(toImageContent),
        );
        if (!completed) {
          return {
            state: "failed",
            captainSessionId: normalized.sessionKey,
            turnId,
            code: "captain_turn_timeout",
          };
        }
      }
    } catch {
      return { state: "failed", turnId, code: "captain_session_failed" };
    } finally {
      if (!normalized.durable) lane.session.dispose();
    }
    if (role === "absorbed") {
      // Heard inside another turn's live run; that run's reply answers it, so
      // this delivery sends nothing of its own.
      return { state: "silent", captainSessionId: normalized.sessionKey, turnId };
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
      const { settings: discord } = resolveDiscordSettings((await settings()).discord);
      const systemTools = discordTurnHasSystemTools({
        lane: normalized.lane,
        actorId: request.trigger.actorId,
        systemActorUserIds: discord.systemActorUserIds,
      });
      if (!normalized.durable) {
        const lane = await buildSession(
          normalized.lane,
          SessionManager.inMemory(options.repoRoot),
          systemTools,
        );
        return runDiscordTurn(lane, normalized, request.deliveryId);
      }
      const lane = await durableSession(
        normalized.sessionKey,
        normalized.lane,
        join(options.stateDir, "voice", encodeURIComponent(normalized.sessionKey)),
        false,
      );
      return runDiscordTurn(lane, normalized, request.deliveryId);
    },

    serveOperatorConversation(
      request: OperatorConversationServiceRequest,
    ): Promise<OperatorConversationServiceResult> {
      return conversations.serve(request);
    },

    async observeLanes(): Promise<readonly ObservableCaptainLane[]> {
      return laneLog.list();
    },

    voiceLaneInstructions(): string {
      return (
        "You are present in a Discord voice channel. You hear only participants permitted by the room's consent policy and you speak " +
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
