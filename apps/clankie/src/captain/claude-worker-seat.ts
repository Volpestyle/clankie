import type { ClaudeHookQuestions } from "./claude-hook-questions.ts";
/**
 * Claude seats through Clankie's `clankie-worker` plugin (VUH-1458, ADR 0203).
 *
 * The worker is the real interactive Claude Code TUI in its herdr pane, so the
 * owner can type into it and everything Claude ships keeps working. Control
 * rides the harness's own extension points:
 *
 * - The brief and every message are channel notifications from the plugin's
 *   MCP server, which serves the seat's mailbox (`clankie mcp --seat`).
 * - Acknowledgment is the message in the session's native transcript, the
 *   receipt VUH-1450 already trusts.
 * - Stop observations (StopFailure for errors) reach the existing SeatHookLog.
 *   They do not identify which channel message completed.
 *
 * Channels need the owner's approval of the installed plugin in managed
 * policy; the development-channel warning is never accepted on their behalf.
 * Until they approve it, `start` is `blocked` and the hire takes the terminal
 * lane, naming the one-time fix.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  HarnessSeatAdapter,
  SeatControl,
  SeatDelivery,
  SeatEvent,
  SeatLaunch,
  SeatRef,
  SeatStartResult,
  SeatStatus,
} from "@clankie/agent-hosts";
import {
  CLAUDE_WORKER_PLUGIN,
  CLAUDE_WORKER_PLUGIN_ID,
  OPERATOR_CONVERSATION_TEXT_MAX,
  OPERATOR_CONVERSATION_SUMMARY_MAX,
  type FleetSeatHook,
  type FleetGates,
} from "@clankie/protocol";
import { resolveHerdrSeatTranscriptPath, type HerdrSeatTranscript } from "./herdr-transcript.ts";
import { claudeTrackerDenyRules } from "./tracker-isolation.ts";

const defaultTrackerDeny = (cwd: string, env?: Readonly<Record<string, string>>) =>
  claudeTrackerDenyRules(cwd, { ...process.env, ...env });

/** What the adapter reads of a herdr agent. */
export interface WorkerSeatAgent {
  readonly paneId: string;
  readonly terminalId: string;
  readonly status: string;
  readonly session?: { readonly kind: "id" | "path"; readonly value: string };
}

export type ClaudeWorkerConsent =
  | { readonly approved: true }
  | { readonly approved: false; readonly detail: string; readonly fix: string };

export interface ClaudeWorkerSeatDeps {
  /** Consent for the profile this launch runs in (its CLAUDE_CONFIG_DIR, when one was chosen). */
  readonly consent: (env?: Readonly<Record<string, string>>) => Promise<ClaudeWorkerConsent>;
  readonly hooks: SeatHookLog;
  /** Current verified workspace policy; absent preserves native permission defaults. */
  readonly fleetGates?: (cwd: string, env?: Readonly<Record<string, string>>) => Promise<FleetGates>;
  readonly hookQuestions?: ClaudeHookQuestions;
  readonly agent: (paneId: string) => Promise<WorkerSeatAgent | undefined>;
  readonly transcript: (agent: WorkerSeatAgent) => Promise<HerdrSeatTranscript | undefined>;
  /** The seat's mailbox: bound while its channel polls, and a message handed to it. */
  readonly mailbox: {
    bound(seatId: string): boolean;
    deliver(
      seatId: string,
      text: string,
      source?: string,
      recipientBinding?: string,
    ): Promise<boolean | Extract<SeatDelivery, { readonly outcome: "unconfirmed" | "accepted" }>>;
  };
  readonly timing?: { readonly readyMs?: number; readonly receiptMs?: number; readonly pollMs?: number };
  /** Deny rules for the tracker connectors a session in `cwd` would inherit. */
  readonly trackerDeny?: (
    cwd: string,
    env?: Readonly<Record<string, string>>,
  ) => readonly string[] | Promise<readonly string[]>;
  /**
   * Where the launch's settings JSON is handed to Claude. Absent, inline; a
   * remote Windows launch writes it to a file there, because Herdr's launcher
   * would not carry its quotes intact (VUH-1527).
   */
  readonly settingsArg?: (json: string) => Promise<string>;
}

const READY_MS = 30_000;
const RECEIPT_MS = 15_000;
const POLL_MS = 250;
const SESSION_LIMIT = 256;
/** Claude Code's machine policy: macOS, or Linux (the hosted image writes it, VUH-1767). */
const CLAUDE_MANAGED_SETTINGS =
  process.platform === "linux"
    ? "/etc/claude-code/managed-settings.json"
    : "/Library/Application Support/ClaudeCode/managed-settings.json";

/**
 * The argv a worker launch adds to `claude`: its plugin for this session only,
 * its approved channel, and deny rules for inherited tracker connectors so its
 * Linear writes go through Clankie's connected account.
 */
/**
 * The worker plugin's own server, which a hire he launched may use without
 * stopping at a permission prompt: it carries only message_clankie and the
 * tools the owner granted that fleet (Claude names a plugin's MCP server
 * `mcp__plugin_<plugin>_<server>`).
 */
const WORKER_SERVER_RULES = [
  `mcp__plugin_${CLAUDE_WORKER_PLUGIN.plugin}_worker`,
  `mcp__plugin_${CLAUDE_WORKER_PLUGIN.plugin}_clankie`,
];

function claudeWorkerSettings(trackerDeny: readonly string[] = []): string {
  // Hired workers use Claude's auto classifier for routine work (James,
  // 2026-10-09). Blanket ask rules override auto mode and stall every command.
  // Managed denies, tracker denies and the permission hook remain authoritative;
  // auto mode does not blanket-allow Bash or approve gated calls.
  return JSON.stringify({
    enabledPlugins: { [CLAUDE_WORKER_PLUGIN_ID]: true },
    permissions: {
      allow: WORKER_SERVER_RULES,
      defaultMode: "auto",
      ...(trackerDeny.length === 0 ? {} : { deny: [...trackerDeny] }),
    },
  });
}

export function claudeWorkerLaunchArgs(
  launch: SeatLaunch,
  trackerDeny: readonly string[] = [],
  /** The settings JSON itself, or a path to a file holding it. */
  settings = claudeWorkerSettings(trackerDeny),
): string[] {
  return [
    "--settings",
    settings,
    "--channels",
    `plugin:${CLAUDE_WORKER_PLUGIN_ID}`,
    ...(launch.resumeSessionId === undefined ? [] : ["--resume", launch.resumeSessionId]),
    ...(launch.model === undefined ? [] : ["--model", launch.model]),
    ...(launch.effort === undefined ? [] : ["--effort", launch.effort]),
    ...(launch.harnessArgs ?? []),
  ];
}

/** A hook as the seam's event: Stop settles a turn, StopFailure settles it with an error. */
function seatEventForHook(hook: FleetSeatHook, at: string): SeatEvent | undefined {
  switch (hook.event) {
    case "Stop":
      return {
        type: "turn_completed",
        at,
        ok: true,
        ...(hook.lastMessage === undefined ? {} : { text: hook.lastMessage }),
      };
    case "StopFailure":
      return {
        type: "turn_completed",
        at,
        ok: false,
        stopReason: hook.error ?? "error",
        ...(hook.lastMessage === undefined ? {} : { text: hook.lastMessage }),
      };
    case "UserPromptSubmit":
      return { type: "turn_started", at };
    case "SessionStart":
      return undefined;
  }
}

interface HookSession {
  readonly paneId: string;
  readonly revision: number;
  readonly last?: SeatEvent;
  readonly lastStop?: {
    readonly sequence: number;
    readonly event: Extract<SeatEvent, { type: "turn_completed" }>;
  };
  /** A handoff may have happened. No currently forwarded hook can clear this. */
  readonly dispatch?: { readonly sequence: number; readonly terminalId: string };
}

function nativeHookEvent(value: unknown): SeatEvent | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const event = value as Record<string, unknown>;
  if (typeof event.at !== "string" || event.at.length > 100) return undefined;
  if (event.type === "turn_started") return { type: "turn_started", at: event.at };
  if (event.type !== "turn_completed" || typeof event.ok !== "boolean") return undefined;
  if (
    event.text !== undefined &&
    (typeof event.text !== "string" || event.text.length > OPERATOR_CONVERSATION_TEXT_MAX)
  )
    return undefined;
  if (
    event.stopReason !== undefined &&
    (typeof event.stopReason !== "string" || event.stopReason.length > OPERATOR_CONVERSATION_SUMMARY_MAX)
  )
    return undefined;
  return {
    type: "turn_completed",
    at: event.at,
    ok: event.ok,
    ...(typeof event.text === "string" ? { text: event.text } : {}),
    ...(typeof event.stopReason === "string" ? { stopReason: event.stopReason } : {}),
  };
}

/** Existing bounded hook log, also retaining uncertainty before channel handoff. */
export class SeatHookLog {
  private readonly path: string;
  private sessions: Record<string, HookSession>;
  private readonly waiters = new Map<string, Set<(event: SeatEvent) => void>>();

  public constructor(path: string) {
    this.path = path;
    this.sessions = this.read();
  }

  public record(paneId: string, hook: FleetSeatHook, at = new Date().toISOString()): void {
    const event = seatEventForHook(hook, at);
    const prior = this.snapshot(hook.sessionId);
    const revision = (prior?.revision ?? 0) + 1;
    const last = event ?? prior?.last;
    this.commit(hook.sessionId, {
      ...prior,
      paneId,
      revision,
      ...(last === undefined ? {} : { last }),
      ...(event?.type === "turn_completed" ? { lastStop: { sequence: revision, event } } : {}),
    });
    if (event?.type !== "turn_completed") return;
    const waiters = this.waiters.get(hook.sessionId);
    this.waiters.delete(hook.sessionId);
    for (const wake of waiters ?? []) wake(event);
  }

  /** Synchronous durable boundary: failure prevents the following mailbox call. */
  public beginDispatch(ref: SeatRef, terminalId: string): void {
    const prior = this.snapshot(ref.sessionId);
    const revision = (prior?.revision ?? 0) + 1;
    this.commit(ref.sessionId, {
      ...prior,
      paneId: ref.paneId,
      revision,
      dispatch: { sequence: revision, terminalId },
    });
  }

  public snapshot(sessionId: string): HookSession | undefined {
    return Object.hasOwn(this.sessions, sessionId) ? this.sessions[sessionId] : undefined;
  }

  public knows(sessionId: string): boolean {
    return this.snapshot(sessionId) !== undefined;
  }
  public latest(sessionId: string): SeatEvent | undefined {
    return this.snapshot(sessionId)?.last;
  }

  /** The next genuine native Stop, not a receipt for an automated message. */
  public next(sessionId: string, signal?: AbortSignal): Promise<SeatEvent> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const waiters = this.waiters.get(sessionId) ?? new Set();
      const wake = (event: SeatEvent) => {
        signal?.removeEventListener("abort", abort);
        resolve(event);
      };
      const abort = () => {
        waiters.delete(wake);
        if (waiters.size === 0 && this.waiters.get(sessionId) === waiters) this.waiters.delete(sessionId);
        reject(signal?.reason);
      };
      waiters.add(wake);
      this.waiters.set(sessionId, waiters);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private read(): Record<string, HookSession> {
    const sessions: Record<string, HookSession> = Object.create(null);
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8")) as {
        schemaVersion?: unknown;
        sessions?: unknown;
      };
      if (
        (value.schemaVersion !== 1 && value.schemaVersion !== 2) ||
        typeof value.sessions !== "object" ||
        value.sessions === null
      )
        return sessions;
      for (const [id, raw] of Object.entries(value.sessions).slice(-SESSION_LIMIT)) {
        if (id.length > 200 || typeof raw !== "object" || raw === null) continue;
        const entry = raw as Record<string, unknown>;
        if (typeof entry.paneId !== "string" || entry.paneId.length > 500) continue;
        const last = nativeHookEvent(entry.last);
        if (value.schemaVersion === 1) {
          // A legacy Stop is authentic retained data, but its dispatch boundary is unknown.
          sessions[id] = {
            paneId: entry.paneId,
            revision: 0,
            ...(last ? { last } : {}),
            ...(last?.type === "turn_completed" ? { lastStop: { sequence: 0, event: last } } : {}),
          };
          continue;
        }
        const revision = entry.revision;
        if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) continue;
        let dispatch: HookSession["dispatch"];
        if (entry.dispatch !== undefined) {
          const d = entry.dispatch as Record<string, unknown>;
          if (
            !d ||
            typeof d.sequence !== "number" ||
            !Number.isSafeInteger(d.sequence) ||
            d.sequence < 0 ||
            d.sequence > revision ||
            typeof d.terminalId !== "string" ||
            d.terminalId.length > 500
          )
            continue;
          dispatch = { sequence: d.sequence, terminalId: d.terminalId };
        }
        let lastStop: HookSession["lastStop"];
        if (entry.lastStop !== undefined) {
          const stop = entry.lastStop as Record<string, unknown>;
          const event = nativeHookEvent(stop?.event);
          if (
            event?.type !== "turn_completed" ||
            typeof stop.sequence !== "number" ||
            !Number.isSafeInteger(stop.sequence) ||
            stop.sequence < 0 ||
            stop.sequence > revision
          )
            continue;
          lastStop = { sequence: stop.sequence, event };
        }
        sessions[id] = {
          paneId: entry.paneId,
          revision,
          ...(last ? { last } : {}),
          ...(dispatch ? { dispatch } : {}),
          ...(lastStop ? { lastStop } : {}),
        };
      }
    } catch {
      /* Missing/unreadable state never establishes a known-empty dispatch history. */
    }
    return sessions;
  }

  private commit(sessionId: string, session: HookSession): void {
    if (!Number.isSafeInteger(session.revision)) throw new Error("Claude hook generation is unavailable");
    const next = { ...this.sessions };
    delete next[sessionId];
    next[sessionId] = session;
    for (const stale of Object.keys(next).slice(0, Math.max(0, Object.keys(next).length - SESSION_LIMIT)))
      delete next[stale];
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 2, sessions: next })}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
    this.sessions = next;
  }
}

const INSTALL_FIX = `Install the worker plugin once from Clankie's marketplace, leaving it off by default (each hire enables it for its own session): claude plugin install ${CLAUDE_WORKER_PLUGIN_ID} && claude plugin disable ${CLAUDE_WORKER_PLUGIN_ID}`;
const POLICY_FIX = `Approve its channel once as this machine's administrator: in ${CLAUDE_MANAGED_SETTINGS}, set "channelsEnabled": true and add { "marketplace": "${CLAUDE_WORKER_PLUGIN.marketplace}", "plugin": "${CLAUDE_WORKER_PLUGIN.plugin}" } to "allowedChannelPlugins", keeping any entries already there (docs/testing/2026-09-26-interactive-swarm-workers/managed-consent.md).`;

/** Whether managed policy approves the worker plugin's channel, from the main file and its drop-ins. */
export function managedPolicyApprovesWorker(path = CLAUDE_MANAGED_SETTINGS): boolean {
  const drop = join(dirname(path), "managed-settings.d");
  const files = [
    path,
    ...(existsSync(drop)
      ? readdirSync(drop)
          .filter((name) => name.endsWith(".json"))
          .sort()
          .map((name) => join(drop, name))
      : []),
  ];
  return policiesApproveWorker(
    files.map((file) => {
      try {
        return readFileSync(file, "utf8");
      } catch {
        return "";
      }
    }),
  );
}

/** The same answer from the policy files' contents, wherever they were read (VUH-1527). */
export function policiesApproveWorker(contents: readonly string[]): boolean {
  let enabled = false;
  let allowed = false;
  for (const content of contents) {
    let value: { channelsEnabled?: unknown; allowedChannelPlugins?: unknown };
    try {
      value = JSON.parse(content) as typeof value;
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    if (value.channelsEnabled === true) enabled = true;
    if (
      Array.isArray(value.allowedChannelPlugins) &&
      value.allowedChannelPlugins.some(
        (entry: { marketplace?: unknown; plugin?: unknown }) =>
          entry?.marketplace === CLAUDE_WORKER_PLUGIN.marketplace &&
          entry.plugin === CLAUDE_WORKER_PLUGIN.plugin,
      )
    )
      allowed = true;
  }
  return enabled && allowed;
}

/** This Mac's answer: the plugin installed from Clankie's marketplace, and its channel approved. */
export async function claudeWorkerChannelConsent(
  options: {
    readonly managedSettingsPath?: string;
    readonly listPlugins?: () => Promise<string>;
  } = {},
): Promise<ClaudeWorkerConsent> {
  const list =
    options.listPlugins ??
    (() =>
      new Promise<string>((resolve, reject) =>
        execFile(
          "claude",
          ["plugin", "list", "--json"],
          { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
          (error, stdout) => (error === null ? resolve(String(stdout)) : reject(error)),
        ),
      ));
  let installed = false;
  try {
    const plugins = JSON.parse(await list()) as unknown;
    installed =
      Array.isArray(plugins) &&
      plugins.some((entry) => (entry as { id?: unknown })?.id === CLAUDE_WORKER_PLUGIN_ID);
  } catch (error) {
    return {
      approved: false,
      detail: `Could not inspect installed Claude plugins: ${error instanceof Error ? error.message : String(error)}`,
      fix: `Run claude plugin list --json in the service environment and resolve its error. ${INSTALL_FIX}`,
    };
  }
  if (!installed)
    return {
      approved: false,
      detail: `${CLAUDE_WORKER_PLUGIN_ID} is not installed.`,
      fix: `${INSTALL_FIX}. ${POLICY_FIX}`,
    };
  if (!managedPolicyApprovesWorker(options.managedSettingsPath))
    return {
      approved: false,
      detail: `Managed policy does not approve the ${CLAUDE_WORKER_PLUGIN_ID} channel, and a development channel would stop at a warning only the owner may accept.`,
      fix: POLICY_FIX,
    };
  return { approved: true };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function until<T>(
  read: () => Promise<T | undefined> | T | undefined,
  ms: number,
  pollMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) return undefined;
    await sleep(pollMs);
  }
}

/** A channel event's body, if this transcript text is one: `<channel …>\nBODY\n</channel>`. */
export function channelBody(text: string): string | undefined {
  return /^<channel\b[^>]*>\n?([\s\S]*?)\n?<\/channel>\s*$/u.exec(text.trim())?.[1];
}

/** The transcript entry id that received this message whole, beyond the ids already there. */
async function receipt(
  deps: ClaudeWorkerSeatDeps,
  agent: WorkerSeatAgent,
  text: string,
  before: ReadonlySet<string>,
  ms: number,
  pollMs: number,
): Promise<string | undefined> {
  const expected = text.replace(/\r\n?/gu, "\n").trim();
  let rejectingRule = "transcript_unavailable";
  const id = await until(
    async () => {
      const transcript = await deps.transcript(agent);
      if (transcript === undefined) {
        rejectingRule = "transcript_unavailable";
        return undefined;
      }
      const candidates = transcript.entries.filter(
        (entry) => entry.type === "message" && entry.role === "operator" && !before.has(entry.id),
      );
      rejectingRule = candidates.length === 0 ? "no_new_operator_message" : "complete_body_mismatch";
      return candidates.find(
        (entry) =>
          entry.type === "message" &&
          (channelBody(entry.text)?.trim() === expected || entry.text.trim() === expected),
      )?.id;
    },
    ms,
    pollMs,
  );
  if (id === undefined) logReceiptRejection(agent, rejectingRule);
  return id;
}

function logReceiptRejection(agent: WorkerSeatAgent, rejectingRule: string): void {
  console.warn(
    "hire_agent.receipt_rejected:",
    JSON.stringify({
      harness: "claude",
      paneId: agent.paneId,
      sessionId: sessionIdOf(agent) ?? null,
      transcriptPath:
        agent.session === undefined
          ? null
          : (resolveHerdrSeatTranscriptPath("claude", { source: "herdr:claude", ...agent.session }) ?? null),
      rejectingRule,
    }),
  );
}

async function transcriptIds(deps: ClaudeWorkerSeatDeps, agent: WorkerSeatAgent): Promise<Set<string>> {
  return new Set((await deps.transcript(agent))?.entries.map((entry) => entry.id));
}

function sessionIdOf(agent: WorkerSeatAgent): string | undefined {
  const session = agent.session;
  if (session === undefined) return undefined;
  return session.kind === "id"
    ? session.value
    : session.value
        .split(/[\\/]/u)
        .at(-1)
        ?.replace(/\.jsonl$/u, "");
}

class ClaudeWorkerSeatControl implements SeatControl {
  public readonly ref: SeatRef;
  private readonly deps: ClaudeWorkerSeatDeps;
  private readonly receiptMs: number;
  private readonly pollMs: number;
  private terminalId: string | undefined;

  public constructor(ref: SeatRef, deps: ClaudeWorkerSeatDeps, terminalId?: string) {
    this.ref = ref;
    this.deps = deps;
    this.terminalId = terminalId;
    this.receiptMs = deps.timing?.receiptMs ?? RECEIPT_MS;
    this.pollMs = deps.timing?.pollMs ?? POLL_MS;
  }

  private matches(agent: WorkerSeatAgent): boolean {
    const saved = this.deps.hooks.snapshot(this.ref.sessionId);
    return (
      agent.paneId === this.ref.paneId &&
      sessionIdOf(agent) === this.ref.sessionId &&
      (this.terminalId === undefined || agent.terminalId === this.terminalId) &&
      (saved === undefined || saved.paneId === this.ref.paneId) &&
      (saved?.dispatch === undefined || saved.dispatch.terminalId === agent.terminalId)
    );
  }

  private async observe(): Promise<{ status: SeatStatus; agent?: WorkerSeatAgent } | undefined> {
    let agent: WorkerSeatAgent | undefined;
    try {
      agent = await this.deps.agent(this.ref.paneId);
    } catch {
      return undefined;
    }
    if (agent === undefined || !this.matches(agent)) return { status: "offline" };
    this.terminalId ??= agent.terminalId;
    if (!this.deps.mailbox.bound(agent.terminalId)) return { status: "released" };
    if (agent.status === "unknown") return undefined;
    return {
      status: agent.status === "working" ? "working" : agent.status === "blocked" ? "blocked" : "idle",
      agent,
    };
  }

  public async pendingQuestion(requestId: string | number) {
    return this.deps.hookQuestions?.pending(this.ref, requestId);
  }

  public async answerQuestion(
    answer: import("@clankie/agent-hosts").SeatQuestionAnswer,
    beforeDispatch?: () => Promise<void>,
    decider?: import("@clankie/agent-hosts").SeatQuestionDecider,
  ): Promise<import("@clankie/agent-hosts").SeatQuestionResult> {
    const agent = await this.deps.agent(this.ref.paneId).catch(() => undefined);
    if (!agent || !this.matches(agent))
      return { outcome: "offline", detail: "Native question occupant changed" };
    return (
      this.deps.hookQuestions?.answer(this.ref, answer, beforeDispatch, decider) ?? {
        outcome: "refused",
        detail: "No pending Claude hook question",
      }
    );
  }

  public async status(): Promise<SeatStatus> {
    return (await this.observe())?.status ?? "offline";
  }

  public async send(message: string, options?: Parameters<SeatControl["send"]>[1]): Promise<SeatDelivery> {
    const agent = await this.deps.agent(this.ref.paneId).catch(() => undefined);
    if (agent === undefined || !this.matches(agent))
      return {
        outcome: "offline",
        deliveryStage: "unavailable",
        detail: "The seat's Claude session is gone",
      };
    if (!this.deps.mailbox.bound(agent.terminalId))
      return { outcome: "released", deliveryStage: "unavailable" };
    const before = await transcriptIds(this.deps, agent);
    const current = await this.observe();
    if (current?.agent === undefined || current.agent.terminalId !== agent.terminalId)
      return {
        outcome: "offline",
        deliveryStage: "unavailable",
        detail: "The seat binding changed before dispatch",
      };
    if (options?.beforeDispatch && !(await options.beforeDispatch().catch(() => false)))
      return {
        outcome: "offline",
        deliveryStage: "unavailable",
        detail: "Peer authority changed before channel dispatch; no message was sent",
      };
    try {
      this.deps.hooks.beginDispatch(this.ref, agent.terminalId);
    } catch {
      return {
        outcome: "unconfirmed",
        deliveryStage: "unavailable",
        messageId: "",
        detail: "The settlement boundary could not be saved; no message was sent",
      };
    }
    const delivery = await (options?.recipientBinding !== undefined
      ? this.deps.mailbox.deliver(agent.terminalId, message, options.source, options.recipientBinding)
      : options?.source === undefined
        ? this.deps.mailbox.deliver(agent.terminalId, message)
        : this.deps.mailbox.deliver(agent.terminalId, message, options.source));
    // An exact authenticated bridge ACK proves transport delivery without waiting
    // for a remote transcript read. It never proves model awareness or completion.
    if (typeof delivery !== "boolean")
      return delivery.outcome === "unconfirmed" ? { ...delivery, deliveryStage: "uncertain" } : delivery;
    if (!delivery) return { outcome: "released", deliveryStage: "unavailable" };
    const id = await receipt(
      this.deps,
      agent,
      message,
      before,
      options?.timeoutMs ?? this.receiptMs,
      this.pollMs,
    );
    const after = await this.observe();
    if (after?.agent === undefined || after.agent.terminalId !== agent.terminalId)
      return {
        outcome: "unconfirmed",
        deliveryStage: "uncertain",
        messageId: id ?? "",
        detail: "The seat binding became unavailable after channel dispatch; completion is unknown",
      };
    if (id === undefined)
      return {
        outcome: "unconfirmed",
        deliveryStage: "uncertain",
        messageId: "",
        detail: "The worker channel took the message, but it has not appeared in the session transcript",
      };
    return {
      outcome: "accepted",
      deliveryStage: "consumed",
      messageId: id,
      // Transcript insertion can be a queued attachment, even while Herdr still looks idle.
      state: "queued",
    };
  }

  public async settled(signal?: AbortSignal): Promise<SeatEvent> {
    signal?.throwIfAborted();
    const at = () => new Date().toISOString();
    const initialSequence = this.deps.hooks.snapshot(this.ref.sessionId)?.revision ?? 0;
    for (;;) {
      signal?.throwIfAborted();
      const held = this.deps.hooks.snapshot(this.ref.sessionId);
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      const next = this.deps.hooks.next(this.ref.sessionId, controller.signal);
      next.catch(() => undefined);
      const aborted = new Promise<never>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      });
      try {
        // Bindings and the persisted generation are checked after this await.
        const observation = await Promise.race([this.observe(), aborted]);
        signal?.throwIfAborted();
        if (this.deps.hooks.snapshot(this.ref.sessionId) !== held) continue;
        if (observation === undefined)
          return { type: "settlement_unconfirmed", at: at(), reason: "status_unavailable" };
        const status = observation.status;
        if (status === "offline") return { type: "exited", at: at(), code: null };
        if (status === "released") return { type: "released", at: at() };
        if (status === "blocked")
          return { type: "blocked", at: at(), reason: "Claude is waiting on the owner in its pane" };
        const stop = held?.last?.type === "turn_completed" ? held.lastStop : undefined;
        // Sequence excludes an already observed Stop, never proves turn causation.
        const eligible =
          stop !== undefined && (held?.dispatch === undefined || stop.sequence > held.dispatch.sequence)
            ? stop
            : undefined;
        if (
          status === "idle" ||
          (eligible !== undefined && (eligible.sequence > initialSequence || held?.dispatch !== undefined))
        ) {
          return {
            type: "settlement_unconfirmed",
            at: at(),
            reason:
              held?.dispatch !== undefined
                ? "message_correlation_unavailable"
                : eligible === undefined
                  ? "no_native_completion"
                  : "dispatch_boundary_unknown",
            ...(eligible === undefined
              ? {}
              : {
                  observedStop: {
                    at: eligible.event.at,
                    ok: eligible.event.ok,
                    ...(eligible.event.text === undefined ? {} : { text: eligible.event.text }),
                    ...(eligible.event.stopReason === undefined
                      ? {}
                      : { stopReason: eligible.event.stopReason }),
                  },
                }),
          };
        }
        // Always re-observe binding/status before using a Stop received while waiting.
        await Promise.race([next, sleep(1_000, controller.signal)]);
      } finally {
        controller.abort();
        signal?.removeEventListener("abort", abort);
      }
    }
  }

  /** Interactive Claude has no programmatic interrupt; the owner presses Esc in the pane. */
  public async interrupt(): Promise<boolean> {
    return false;
  }

  /** Nothing runs beside the pane, so closing it is all there is. */
  public async close(): Promise<void> {}
}

export function createClaudeWorkerSeatAdapter(deps: ClaudeWorkerSeatDeps): HarnessSeatAdapter {
  const readyMs = deps.timing?.readyMs ?? READY_MS;
  const receiptMs = deps.timing?.receiptMs ?? RECEIPT_MS;
  const pollMs = deps.timing?.pollMs ?? POLL_MS;
  return {
    harness: "claude",
    async start(launch, view): Promise<SeatStartResult> {
      if (launch.harness !== "claude" || view.start === undefined)
        return {
          outcome: "failed",
          reason: "harness_unavailable",
          detail: "This pane cannot start interactive Claude",
        };
      const consent = await deps.consent(launch.env);
      if (!consent.approved)
        return { outcome: "blocked", reason: "consent_required", detail: consent.detail, fix: consent.fix };
      try {
        const trackerDeny = await (deps.trackerDeny ?? defaultTrackerDeny)(launch.cwd, launch.env);
        const settings = claudeWorkerSettings(trackerDeny);
        await view.start(
          "claude",
          claudeWorkerLaunchArgs(
            launch,
            trackerDeny,
            deps.settingsArg ? await deps.settingsArg(settings) : settings,
          ),
        );
      } catch (error) {
        return {
          outcome: "failed",
          reason: "not_ready",
          detail: `Claude did not come up with the worker channel (a consent or trust prompt waits in the pane?): ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      const agent = await until(
        async () => {
          const current = await deps.agent(view.paneId).catch(() => undefined);
          return current !== undefined && sessionIdOf(current) !== undefined ? current : undefined;
        },
        readyMs,
        pollMs,
      );
      const sessionId = agent === undefined ? undefined : sessionIdOf(agent);
      if (agent === undefined || sessionId === undefined)
        return {
          outcome: "failed",
          reason: "not_ready",
          detail: "Claude started without reporting its session to herdr",
        };
      if (launch.resumeSessionId !== undefined && sessionId !== launch.resumeSessionId)
        return {
          outcome: "failed",
          reason: "not_ready",
          detail: "Claude resumed a different session; no brief was sent",
        };
      // Readiness is the channel's own poll, never a connected MCP server alone (ADR 0194).
      if (
        (await until(() => (deps.mailbox.bound(agent.terminalId) ? true : undefined), readyMs, pollMs)) ===
        undefined
      )
        return {
          outcome: "failed",
          reason: "not_ready",
          detail: `channel_unready: the ${CLAUDE_WORKER_PLUGIN_ID} channel never started polling the seat's mailbox`,
        };
      const control = new ClaudeWorkerSeatControl(
        { harness: "claude", sessionId, paneId: view.paneId },
        deps,
        agent.terminalId,
      );
      if (launch.brief.length > 0) {
        await view.guard?.();
        const delivery = await control.send(launch.brief, { timeoutMs: receiptMs });
        if (delivery.outcome !== "accepted")
          return {
            outcome: "failed",
            reason: "not_ready",
            detail: `brief_delivery_unverified: ${JSON.stringify(delivery)}`,
          };
      }
      try {
        deps.hooks.record(view.paneId, { schemaVersion: 1, event: "SessionStart", sessionId });
      } catch {
        return {
          outcome: "failed",
          reason: "not_ready",
          detail: "brief_delivery_unverified: the native hook boundary could not be saved",
        };
      }
      return { outcome: "started", control };
    },
    async attach(ref): Promise<SeatControl | undefined> {
      if (ref.harness !== "claude" || !deps.hooks.knows(ref.sessionId)) return undefined;
      const control = new ClaudeWorkerSeatControl(ref, deps);
      const status = await control.status();
      return status === "offline" || status === "released" ? undefined : control;
    },
  };
}
