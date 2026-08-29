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
  type OperatorConversationActivityPhase,
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
  SettingsManager,
  type AgentSession,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { ConversationStore } from "./conversations.ts";
import { AutonomyStore } from "./autonomy.ts";
import { readFleetSeats, readHerdrSessionCensus, type HerdrSessionCensus } from "./herdr-census.ts";
import { HerdrTerminalStore } from "./herdr-terminal.ts";
import { HerdrWatchStore } from "./herdr-watch.ts";
import { operatorPromptWithHerdrSeat } from "./herdr-seat.ts";
import type { CaptainDeps, ResolvedAttachment } from "./deps.ts";
import { discordTurnSessionKey, normalizeDiscordTurn, type NormalizedDiscordTurn } from "./discord-turn.ts";
import { DiscordToolProgressReporter } from "./discord-tool-progress.ts";
import { LaneLog, laneKey } from "./lane-log.ts";
import { createCaptainModelRuntime, type CaptainModelRuntime } from "./model.ts";
import type { CaptainPort } from "./port.ts";
import { connectionTools } from "./connect-tools.ts";
import { planDiscordTurnSession } from "./system-authority.ts";
import { browserExtension, captainTools, mcpExtension, roomKey, type TurnContext } from "./tools.ts";
import {
  contextTokenCount,
  recordPiToolStart,
  tryAppendTurnSettled,
  TurnMetrics,
  TurnSettledLog,
  turnSettledLogPath,
  type TurnSettledOutcome,
} from "./turn-metrics.ts";

const REGISTER_FOR_LANE: Readonly<Record<CaptainSessionLaneV2, PersonaRegister>> = {
  operator: "operator",
  discord_voice: "social",
  discord_presence: "social",
  gameplay: "gameplay",
};

const TOOL_DETAIL_TRUNCATED = "\n… truncated";
/**
 * How long a Discord turn may show no sign of life before it is declared dead.
 *
 * This is not a limit on how long he may take. Asking him to look something up
 * — a bracket, a page, a task worth real work — is a thing the room is allowed
 * to do, and a clock that cuts the answer off at some tidy number turns honest
 * slowness into failure. He posts a text update (`send_text_update`) and takes
 * the time the work takes.
 *
 * What is bounded is silence *inside* the machine. A turn that is working emits
 * events continuously — tokens, tool calls, retries — so five minutes with not
 * one of them is not a long thought, it is a dead stream nothing will revive:
 * on 2026-08-17 a provider connection died and the turn sat with zero tokens
 * for six minutes before anything noticed.
 */
export const DISCORD_TURN_STALL_MS = 5 * 60_000;
/**
 * How often the watchdog re-reads the wall clock.
 *
 * A single `setTimeout` is not a deadline on a laptop. This machine suspends,
 * and a suspended timer resumes owing its full remaining delay: a ten-minute
 * backstop once fired twenty-two minutes late, holding a turn — and the room's
 * answer — open the whole time. Re-reading `Date.now()` on a short tick bounds
 * the overshoot to one tick of *awake* time no matter how long the host slept.
 */
const STALL_TICK_MS = 5_000;

/**
 * An empty memory still says so. A missing card reads as "you have no memory",
 * and nothing else in the prompt would ever prompt the first write — so the
 * store's existence is on every turn and the floor retires itself once he
 * writes one. A recall *failure* stays silent: a broken store degrades the
 * prompt, it does not lie about what he remembers.
 */
const EMPTY_EPISODE_CARD = [
  "## What you remember doing recently",
  "Nothing yet — you have not written an episode. `remember_episode` is how one gets here.",
].join("\n");

/** Refresh bounded episodic recall as trusted context for every Pi run. */
export function captainMemoryExtension(memory: CaptainDeps["memory"], lane: CaptainSessionLaneV2) {
  return {
    name: "captain-memory",
    hidden: true,
    factory(pi) {
      pi.on("before_agent_start", async (event) => {
        const card = await memory.recallEpisodeCard(lane).catch(() => undefined);
        if (card === undefined) return undefined;
        const rendered = card.length === 0 ? EMPTY_EPISODE_CARD : card;
        return { systemPrompt: `${event.systemPrompt}\n\n${rendered}` };
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
  /** Real process-level overrides captured before stored settings are projected into child env. */
  readonly discordEnvironment?: NodeJS.ProcessEnv;
}

interface LaneSession {
  readonly session: AgentSession;
  readonly capture: TurnContext;
  modelRef: string;
  lastAssistantText: string;
  turnCounter: number;
  /** Settlement of the in-flight run, while one is active: true if it succeeded. */
  running?: Promise<boolean> | undefined;
  /**
   * Operator turns hold this while they prepare (model sync, lane-log, herdr
   * census) so a concurrent human send waits and then steers instead of starting
   * a second prompt.
   */
  starting?: Promise<void> | undefined;
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
    starting?: Promise<void> | undefined;
  },
  prompt: string,
  images: ImageContent[],
  options?: { expandPromptTemplates?: boolean },
): Promise<"ran" | "absorbed"> {
  const expandPromptTemplates = options?.expandPromptTemplates ?? false;
  for (;;) {
    const running = lane.running;
    if (running === undefined && lane.starting === undefined) {
      // The idle check and the prompt() call share one synchronous stretch —
      // with template expansion off pi reaches its own streaming check without
      // awaiting — so the state observed here is the state it acts on.
      lane.capture.media = undefined;
      const run = lane.session.prompt(prompt, { expandPromptTemplates, images });
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
        expandPromptTemplates,
        streamingBehavior: "steer",
        images,
      });
      if (running === undefined || !(await running)) {
        throw new Error("The run this turn was steered into failed");
      }
      return "absorbed";
    }
    // A run is accepted but not streaming yet, still preparing, or is winding
    // down: wait it out and re-decide.
    await (lane.starting ?? running);
  }
}

/**
 * Run a Discord turn for as long as it keeps working, aborting only once it
 * has gone quiet inside for {@link DISCORD_TURN_STALL_MS}.
 *
 * The session's own event stream is the liveness signal: a token, a tool call,
 * a retry — anything at all — is proof the turn is still a turn, and resets the
 * clock. Nothing here caps total duration, because the length of an answer is
 * the length of the work behind it.
 *
 * Every Discord turn goes through here, one-shot and durable alike. A durable
 * lane had no backstop at all before, which was survivable only while text was
 * one-shot; a shared lane that wedges takes every speaker in the channel down
 * with it, so it is the path that needs the watchdog most.
 */
export async function runTurnWithStallWatchdog<T>(
  session: Pick<AgentSession, "abort" | "subscribe">,
  start: () => Promise<T>,
  options: { stallMs?: number; now?: () => number } = {},
): Promise<{ completed: true; value: T } | { completed: false }> {
  const now = options.now ?? Date.now;
  const stallMs = options.stallMs ?? DISCORD_TURN_STALL_MS;
  let lastSignAtMs = now();
  const unsubscribe = session.subscribe(() => {
    lastSignAtMs = now();
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<false>((resolve) => {
    const tick = (): void => {
      const quietFor = now() - lastSignAtMs;
      if (quietFor >= stallMs) {
        resolve(false);
        return;
      }
      timer = setTimeout(tick, Math.min(STALL_TICK_MS, stallMs - quietFor));
      timer.unref?.();
    };
    tick();
  });
  try {
    const outcome = await Promise.race([start().then((value) => ({ value })), stalled]);
    if (outcome === false) {
      void session.abort().catch(() => undefined);
      return { completed: false };
    }
    return { completed: true, value: outcome.value };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe();
  }
}

/** A one-shot Discord turn under the shared watchdog; `false` means it went dead, not slow. */
export async function runOneShotDiscordTurn(
  session: Pick<AgentSession, "abort" | "prompt" | "subscribe">,
  prompt: string,
  images: ImageContent[],
  stallMs = DISCORD_TURN_STALL_MS,
): Promise<boolean> {
  const outcome = await runTurnWithStallWatchdog(
    session,
    () => session.prompt(prompt, { expandPromptTemplates: false, images }),
    { stallMs },
  );
  return outcome.completed;
}

/**
 * The captain on pi. Sessions are pi's JSONL trees throughout: continuing ones
 * for operator conversations and durable Discord lanes, and a fresh tree for
 * every actor-level system grant in a shared room. Nothing carries forward out
 * of a one-shot — the bounded channel history arrives with each request — but
 * its tree stays because that is the only record of the tools it ran (ADR
 * 0107). The persona still comes from owner-authored settings, never from the
 * caller.
 */
export function createCaptain(deps: CaptainDeps, options: CaptainOptions): CaptainPort {
  const laneLog = new LaneLog(join(options.stateDir, "lanes"));
  const autonomy = new AutonomyStore(join(options.stateDir, "autonomy.json"));
  const herdrTerminals = new HerdrTerminalStore();
  const herdrWatches = new HerdrWatchStore(join(options.stateDir, "herdr-watches.json"));
  const turnSettled = new TurnSettledLog(turnSettledLogPath(options.stateDir));
  const sessions = new Map<string, Promise<LaneSession>>();
  const settingsStore = options.settings ?? new SettingsStore();
  let modelRuntime: Promise<CaptainModelRuntime> | undefined;

  const settings = (): Promise<ClankieSettings> => settingsStore.load();
  const runtime = (): Promise<CaptainModelRuntime> =>
    (modelRuntime ??= createCaptainModelRuntime(options.repoRoot));

  function systemPrompt(
    lane: CaptainSessionLaneV2,
    systemTools: boolean,
    currentSettings: ClankieSettings,
  ): string {
    const identity = readFileSync(join(import.meta.dirname, "instructions.md"), "utf8");
    const persona = personaInstructions(currentSettings.persona, REGISTER_FOR_LANE[lane]);
    const reach = systemTools
      ? [
          "",
          "# Machine access",
          "You have shell and filesystem tools in this authorized context. `herdr` talks to the local socket from this service. When a turn names your herdr pane, you have joined that session: the agents in `<herdr_session>` are yours to lead, route, and harvest. When it names none, you are on the socket only. Never run bare `herdr-lead` from this shell — that starts a TUI in-process and hangs.",
        ].join("\n")
      : [
          "",
          "# This room",
          "You do not have a shell or filesystem tools in this room. If someone asks you to inspect herdr, run a command, or read a file, say you cannot from here. Do not imply you chose not to look.",
        ].join("\n");
    // His own address is a fact he should be able to say without calling a tool
    // for it, and it belongs to whichever mailbox is actually connected — so it
    // is derived from settings rather than written into the persona a second
    // time, where it would drift the day the mailbox changes.
    const mailbox = currentSettings.email.fromAddress ?? currentSettings.email.username;
    const address =
      mailbox === undefined
        ? ""
        : [
            "",
            "# Your address",
            "",
            `Your own mailbox is ${mailbox}. That is how someone reaches you directly, and you can give it out. Reading it stays at the console.`,
          ].join("\n");
    return `${identity}\n\n${persona}${reach}${address}`;
  }

  /**
   * Where a session's tools run. A workspace-scoped operator conversation
   * works in its own directory, so the project resources it picks up (AGENTS.md,
   * that repo's skills) are the ones for the code in front of him. Clankie's own
   * skills stay on the path from the service repo either way, and every other
   * lane works in the service repo.
   */
  async function buildSession(
    lane: CaptainSessionLaneV2,
    sessionManager: SessionManager,
    systemTools: boolean,
    cwd: string,
  ): Promise<LaneSession> {
    const capture: TurnContext = {};
    const { runtime: models, resolveSelection } = await runtime();
    const currentSettings = await settings();
    const selection = await resolveSelection();
    const piSettings = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: getAgentDir(),
      systemPrompt: systemPrompt(lane, systemTools, currentSettings),
      noExtensions: true,
      extensionFactories: [
        captainMemoryExtension(deps.memory, lane),
        browserExtension(deps, capture),
        mcpExtension(deps, lane),
      ],
      noPromptTemplates: true,
      additionalSkillPaths: [join(options.repoRoot, ".agents", "skills")],
      settingsManager: piSettings,
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd,
      model: selection.model,
      thinkingLevel: selection.thinkingLevel,
      modelRuntime: models,
      customTools: [
        ...captainTools(deps, capture, laneLog, lane, currentSettings.gameplay, autonomy, herdrWatches),
        ...connectionTools(deps, lane),
      ],
      resourceLoader: loader,
      sessionManager,
      settingsManager: piSettings,
      // Coding tools (read/bash/edit/write) run unsandboxed as the service
      // user. The operator console always has them. Discord gets them only from
      // the authenticated authority plan: per-user grants stay one-shot in
      // shared rooms, while private owner DMs and explicitly trusted guild
      // lanes may bind them durably. A tools list is a boundary; prompt framing
      // around untrusted channel history is not.
      ...(systemTools ? {} : { noTools: "builtin" as const }),
    });
    await session.bindExtensions({ mode: "print" });
    const laneSession: LaneSession = {
      session,
      capture,
      modelRef: selection.ref,
      lastAssistantText: "",
      turnCounter: 0,
    };
    session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        laneSession.lastAssistantText = assistantText(event.message);
      }
    });
    return laneSession;
  }

  async function syncModel(lane: LaneSession): Promise<void> {
    const selection = await (await runtime()).resolveSelection();
    if (lane.modelRef !== selection.ref) {
      await lane.session.setModel(selection.model);
      lane.modelRef = selection.ref;
    }
    if (lane.session.thinkingLevel !== selection.thinkingLevel) {
      lane.session.setThinkingLevel(selection.thinkingLevel);
    }
  }

  function durableSession(
    key: string,
    lane: CaptainSessionLaneV2,
    dir: string,
    systemTools: boolean,
    cwd: string,
  ): Promise<LaneSession> {
    const existing = sessions.get(key);
    if (existing !== undefined) return existing;
    const created = (async () => {
      let manager: SessionManager;
      try {
        manager = SessionManager.continueRecent(cwd, dir);
      } catch {
        manager = SessionManager.create(cwd, dir);
      }
      return buildSession(lane, manager, systemTools, cwd);
    })();
    sessions.set(key, created);
    created.catch(() => sessions.delete(key));
    return created;
  }

  const conversations = new ConversationStore(
    join(options.stateDir, "conversations"),
    async (conversationId, message, publish, context) => {
      const lane = await durableSession(
        `operator:${conversationId}`,
        "operator",
        join(options.stateDir, "conversations", conversationId, "pi"),
        true,
        context.workspace ?? options.repoRoot,
      );
      let releaseStarting: (() => void) | undefined;
      if (lane.running === undefined && lane.starting === undefined && !lane.session.isStreaming) {
        lane.starting = new Promise<void>((resolve) => {
          releaseStarting = resolve;
        });
        lane.capture.media = undefined;
        lane.capture.autonomous = context.internal === true;
      }
      lane.capture.room = roomKey("operator", conversationId);
      lane.capture.targetId = conversationId;
      if (releaseStarting === undefined && lane.starting !== undefined) await lane.starting;

      const live = lane.running !== undefined || lane.session.isStreaming;
      const operatorTokensStart = contextTokenCount(lane.session.getContextUsage());
      const metrics = live
        ? undefined
        : new TurnMetrics({
            conversationId,
            lane: "operator",
            runId: context.runId,
            acceptedAt: context.acceptedAt,
            ...(operatorTokensStart === undefined ? {} : { contextTokensStart: operatorTokensStart }),
          });
      const skillCalls = new Map<string, string>();
      const goalWasActive = autonomy.getGoal(conversationId)?.status === "active";
      let runTokens = 0;
      let activity: OperatorConversationActivityPhase | undefined;
      const publishActivity = (phase: OperatorConversationActivityPhase): void => {
        if (activity === phase) return;
        activity = phase;
        publish({ type: "activity", phase });
      };
      const unsubscribe = live
        ? () => undefined
        : lane.session.subscribe((event) => {
            if (event.type === "message_update") {
              if (
                event.assistantMessageEvent.type === "thinking_start" ||
                event.assistantMessageEvent.type === "thinking_delta"
              ) {
                publishActivity("thinking");
              } else if (
                event.assistantMessageEvent.type === "text_start" ||
                event.assistantMessageEvent.type === "text_delta"
              ) {
                publishActivity("responding");
              } else if (
                event.assistantMessageEvent.type === "toolcall_start" ||
                event.assistantMessageEvent.type === "toolcall_delta"
              ) {
                publishActivity("preparing_tool");
              }
            } else if (event.type === "tool_execution_start") {
              activity = undefined;
              if (metrics !== undefined) recordPiToolStart(metrics, event);
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
            } else if (event.type === "compaction_start") {
              publishActivity("compacting");
            } else if (event.type === "auto_retry_start") {
              publishActivity("retrying");
            } else if (event.type === "auto_retry_end") {
              publishActivity("waiting");
            } else if (event.type === "compaction_end") {
              publishActivity("waiting");
              const usage = lane.session.getContextUsage();
              if (usage !== undefined) {
                publish({
                  type: "context",
                  usage: { tokens: usage.tokens, contextWindow: usage.contextWindow },
                });
              }
            } else if (event.type === "message_end" && event.message.role === "assistant") {
              runTokens += event.message.usage.totalTokens;
              const usage = lane.session.getContextUsage();
              if (usage !== undefined) {
                publish({
                  type: "context",
                  usage: { tokens: usage.tokens, contextWindow: usage.contextWindow },
                });
              }
            }
          });
      let settled: TurnSettledOutcome | undefined;
      try {
        if (!live) await syncModel(lane);
        await laneLog.append("operator", conversationId, {
          at: new Date().toISOString(),
          kind: "heard",
          text: message,
        });
        const paneId = context.seat?.herdrPaneId;
        const census = live || paneId === undefined ? undefined : await readHerdrSessionCensus(paneId);
        const prompt = resolveOperatorPrompt(
          message,
          lane.session.resourceLoader.getSkills().skills,
          paneId,
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
        if (releaseStarting !== undefined) {
          releaseStarting();
          lane.starting = undefined;
          releaseStarting = undefined;
        }
        // The resource loader disables discovered extensions and prompt templates;
        // exact, loaded operator skills are the only input allowed to reach Pi expansion.
        const role = await runDurableTurn(lane, prompt.prompt, [], {
          expandPromptTemplates: prompt.skillName !== undefined,
        });
        if (role === "absorbed") return;
        const text = lane.lastAssistantText.trim();
        publish({ type: "message", role: "captain", text, streaming: false });
        await laneLog.append("operator", conversationId, {
          at: new Date().toISOString(),
          kind: "said",
          text,
        });
        if (goalWasActive || autonomy.getGoal(conversationId)?.status === "active") {
          autonomy.finishTurn(conversationId, runTokens);
        }
        settled = "completed";
      } catch (error) {
        if (metrics !== undefined) settled = "failed";
        throw error;
      } finally {
        if (settled !== undefined) {
          tryAppendTurnSettled(
            turnSettled,
            metrics,
            settled,
            new Date(),
            contextTokenCount(lane.session.getContextUsage()),
          );
        }
        if (releaseStarting !== undefined) {
          releaseStarting();
          lane.starting = undefined;
        }
        unsubscribe();
      }
    },
    (conversationId, scope) => {
      autonomy.clearConversation(conversationId);
      herdrWatches.cancelConversation(conversationId);
      if (scope.kind === "seat") herdrWatches.untrackSeat(scope.seatId);
      const key = `operator:${conversationId}`;
      const pending = sessions.get(key);
      sessions.delete(key);
      void pending?.then((lane) => lane.session.dispose()).catch(() => undefined);
    },
    (seatId, message) => herdrWatches.sendToSeat(seatId, message),
  );

  autonomy.start(async (conversationId, prompt) => {
    if (!conversations.has(conversationId) || conversations.isSeatConversation(conversationId)) {
      autonomy.clearConversation(conversationId);
      return;
    }
    const result = conversations.submitInternal(conversationId, prompt);
    if (result.status !== "accepted") throw new Error("Internal autonomy turn was not accepted");
    if (!(await conversations.awaitRunResult(result.runId))) {
      throw new Error("Internal autonomy turn failed");
    }
  });

  herdrWatches.start(
    (conversationId, prompt) => {
      if (!conversations.has(conversationId) || conversations.isSeatConversation(conversationId)) {
        herdrWatches.cancelConversation(conversationId);
        return Promise.resolve();
      }
      const result = conversations.submitInternal(conversationId, prompt);
      if (result.status !== "accepted") throw new Error("Internal Herdr watcher turn was not accepted");
      return Promise.resolve();
    },
    (seatId, projection) => {
      conversations.publishSeatEvent(
        seatId,
        projection.kind === "status"
          ? { type: "activity", phase: projection.status === "working" ? "responding" : "waiting" }
          : { type: "message", role: "agent", text: projection.text, streaming: false },
      );
    },
  );
  for (const seatId of conversations.seatIds()) herdrWatches.trackSeat(seatId);

  async function runDiscordTurn(
    lane: LaneSession,
    normalized: Awaited<ReturnType<typeof normalizeDiscordTurn>>,
    deliveryId: string,
    toolProgressEnabled: boolean,
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
    const live = lane.running !== undefined || lane.session.isStreaming;
    const discordTokensStart = contextTokenCount(lane.session.getContextUsage());
    const metrics = live
      ? undefined
      : new TurnMetrics({
          conversationId: normalized.sessionKey,
          lane: normalized.lane,
          runId: turnId,
          acceptedAt: new Date().toISOString(),
          ...(discordTokensStart === undefined ? {} : { contextTokensStart: discordTokensStart }),
        });
    const toolProgress =
      live || !toolProgressEnabled || normalized.guildId === undefined || deps.discordActions === undefined
        ? undefined
        : new DiscordToolProgressReporter(
            {
              turnId,
              actorId: normalized.actorId,
              guildId: normalized.guildId,
              channelId: normalized.channelId,
              messageId: normalized.messageId,
            },
            deps.discordActions,
          );
    const unsubscribeEvents =
      metrics === undefined && toolProgress === undefined
        ? () => undefined
        : lane.session.subscribe((event) => {
            if (metrics !== undefined) recordPiToolStart(metrics, event);
            if (event.type === "tool_execution_start") {
              toolProgress?.toolStarted(event.toolCallId, event.toolName);
            } else if (event.type === "tool_execution_end") {
              toolProgress?.toolEnded(event.toolCallId, event.isError);
            }
          });
    let role: "ran" | "absorbed" = "ran";
    let early: CaptainChannelTurnResult | undefined;
    let settled: TurnSettledOutcome | undefined;
    let tokensEnd: number | undefined;
    try {
      if (normalized.durable) {
        if (lane.running === undefined && !lane.session.isStreaming) await syncModel(lane);
        const outcome = await runTurnWithStallWatchdog(lane.session, () =>
          runDurableTurn(lane, normalized.prompt, normalized.images.map(toImageContent)),
        );
        if (!outcome.completed) {
          settled = "interrupted";
          early = {
            state: "failed",
            captainSessionId: normalized.sessionKey,
            turnId,
            code: "captain_turn_stalled",
          };
        } else {
          role = outcome.value;
        }
      } else {
        const completed = await runOneShotDiscordTurn(
          lane.session,
          normalized.prompt,
          normalized.images.map(toImageContent),
        );
        if (!completed) {
          settled = "interrupted";
          early = {
            state: "failed",
            captainSessionId: normalized.sessionKey,
            turnId,
            code: "captain_turn_stalled",
          };
        }
      }
    } catch {
      settled = "failed";
      early = { state: "failed", turnId, code: "captain_session_failed" };
    } finally {
      tokensEnd = contextTokenCount(lane.session.getContextUsage());
      unsubscribeEvents();
      if (!normalized.durable) lane.session.dispose();
    }
    if (early !== undefined) {
      await toolProgress?.fail();
      tryAppendTurnSettled(turnSettled, metrics, settled ?? "failed", new Date(), tokensEnd);
      return early;
    }
    if (role === "absorbed") {
      // Heard inside another turn's live run: that run's reply answers this
      // message too, so the delivery says so rather than sending words of its
      // own. Distinct from silence — he did answer, just not from here.
      await toolProgress?.dismiss();
      return { state: "absorbed", captainSessionId: normalized.sessionKey, turnId };
    }
    const message = lane.lastAssistantText.trim();
    if (message.length === 0) {
      await toolProgress?.fail();
      tryAppendTurnSettled(turnSettled, metrics, "failed", new Date(), tokensEnd);
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
      await toolProgress?.dismiss();
      tryAppendTurnSettled(turnSettled, metrics, "completed", new Date(), tokensEnd);
      return { state: "silent", captainSessionId: normalized.sessionKey, turnId };
    }
    await laneLog.append(normalized.lane, normalized.targetId, {
      at: new Date().toISOString(),
      kind: "said",
      text: message,
    });
    await toolProgress?.complete();
    tryAppendTurnSettled(turnSettled, metrics, "completed", new Date(), tokensEnd);
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
      const { settings: discord } = resolveDiscordSettings(
        (await settings()).discord,
        options.discordEnvironment,
      );
      const plan = planDiscordTurnSession({
        baseSessionKey: discordTurnSessionKey(request),
        durable: true,
        actorId: request.trigger.actorId,
        ...(request.trigger.guildId === undefined ? {} : { guildId: request.trigger.guildId }),
        channelId: request.trigger.channelId,
        transportKind: request.identity.transportKind,
        settings: discord,
      });
      // Whether this exact authority lane is already live decides what he needs
      // to be told. A one-shot never owns history, even when the social lane in
      // the same room is warm. A lane resumed after restart reads as cold and
      // gets one redundant bounded backlog once per boot.
      const heard = await normalizeDiscordTurn(request, deps, {
        carriesHistory: plan.durable && sessions.has(plan.sessionKey),
      });
      const normalized: NormalizedDiscordTurn = {
        ...heard,
        sessionKey: plan.sessionKey,
        durable: plan.durable,
      };
      const toolProgressEnabled =
        normalized.lane === "discord_presence" &&
        request.trigger.unprompted !== true &&
        normalized.guildId !== undefined &&
        discord.toolProgressChannelIds.includes(normalized.channelId);
      if (!normalized.durable) {
        // One-shot for context, durable for evidence: a fresh session per turn
        // (nothing carries forward), but written to disk under the room's own
        // directory so what he actually did — every tool call and result — is
        // readable afterwards. This is the only trail a privileged turn's shell
        // leaves; the receipts above it are content-free by design.
        // ponytail: one file per turn, unbounded; prune by mtime if a busy room
        // ever makes the directory unwieldy.
        const lane = await buildSession(
          normalized.lane,
          SessionManager.create(
            options.repoRoot,
            join(options.stateDir, "turns", laneKey(normalized.lane, normalized.targetId)),
          ),
          plan.systemTools,
          options.repoRoot,
        );
        return runDiscordTurn(lane, normalized, request.deliveryId, toolProgressEnabled);
      }
      // Voice keeps the directory it has always written to; text rooms get
      // their own beside it rather than moving in under a name that means
      // something else.
      const lane = await durableSession(
        normalized.sessionKey,
        normalized.lane,
        join(
          options.stateDir,
          normalized.lane === "discord_voice" ? "voice" : "rooms",
          encodeURIComponent(normalized.sessionKey),
        ),
        plan.systemTools,
        options.repoRoot,
      );
      return runDiscordTurn(lane, normalized, request.deliveryId, toolProgressEnabled);
    },

    async serveOperatorConversation(
      request: OperatorConversationServiceRequest,
    ): Promise<OperatorConversationServiceResult> {
      if (request.op === "terminal_tail") {
        return {
          op: "terminal_tail",
          schemaVersion: 1,
          result: await herdrTerminals.tail(request.observation),
        };
      }
      if (request.op === "autonomy") {
        if (!conversations.has(request.conversationId)) {
          throw new Error(`Unknown conversation ${request.conversationId}`);
        }
        if (conversations.isSeatConversation(request.conversationId)) {
          throw new Error("Seat conversations do not have captain autonomy");
        }
        return Promise.resolve({
          op: "autonomy",
          schemaVersion: 1,
          status: autonomy.command(request.conversationId, request.command),
        });
      }
      if (request.op === "roster") {
        const seats = await readFleetSeats();
        return {
          op: "roster",
          schemaVersion: 1,
          seats: seats.map((seat) => {
            const conversationId = conversations.conversationIdForSeat(seat.seatId);
            return { ...seat, ...(conversationId === undefined ? {} : { conversationId }) };
          }),
        };
      }
      const result = await conversations.serve(request);
      if (request.op === "create" && request.scope.kind === "seat") {
        herdrWatches.trackSeat(request.scope.seatId);
      }
      return result;
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
      herdrTerminals.close();
      herdrWatches.close();
      autonomy.close();
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
