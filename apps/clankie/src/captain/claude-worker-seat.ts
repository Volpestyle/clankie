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
 * - Completion is the plugin's Stop hook (StopFailure for errors), reported by
 *   `clankie seat-hook` into a `SeatHookLog`.
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
import { CLAUDE_WORKER_PLUGIN, CLAUDE_WORKER_PLUGIN_ID, type FleetSeatHook } from "@clankie/protocol";
import { resolveHerdrSeatTranscriptPath, type HerdrSeatTranscript } from "./herdr-transcript.ts";

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
  readonly consent: () => Promise<ClaudeWorkerConsent>;
  readonly hooks: SeatHookLog;
  readonly agent: (paneId: string) => Promise<WorkerSeatAgent | undefined>;
  readonly transcript: (agent: WorkerSeatAgent) => Promise<HerdrSeatTranscript | undefined>;
  /** The seat's mailbox: bound while its channel polls, and a message handed to it. */
  readonly mailbox: {
    bound(seatId: string): boolean;
    deliver(
      seatId: string,
      text: string,
    ): Promise<boolean | Extract<SeatDelivery, { readonly outcome: "unconfirmed" }>>;
  };
  readonly timing?: { readonly readyMs?: number; readonly receiptMs?: number; readonly pollMs?: number };
}

const READY_MS = 30_000;
const RECEIPT_MS = 15_000;
const POLL_MS = 250;
const SESSION_LIMIT = 256;
const CLAUDE_MANAGED_SETTINGS = "/Library/Application Support/ClaudeCode/managed-settings.json";

/** The argv a worker launch adds to `claude`: its plugin for this session only, and its approved channel. */
export function claudeWorkerLaunchArgs(launch: SeatLaunch): string[] {
  return [
    "--settings",
    JSON.stringify({ enabledPlugins: { [CLAUDE_WORKER_PLUGIN_ID]: true } }),
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
  paneId: string;
  last?: SeatEvent;
}

/**
 * What each hired seat's worker plugin has reported, by Claude session id.
 * Durable, so a restarted service still knows which seats the plugin drives.
 */
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
    const session = this.sessions[hook.sessionId] ?? { paneId };
    delete this.sessions[hook.sessionId];
    this.sessions[hook.sessionId] = {
      paneId,
      ...((event ?? session.last) ? { last: event ?? session.last } : {}),
    };
    const ids = Object.keys(this.sessions);
    for (const stale of ids.slice(0, Math.max(0, ids.length - SESSION_LIMIT))) delete this.sessions[stale];
    this.save();
    if (event?.type !== "turn_completed") return;
    for (const wake of this.waiters.get(hook.sessionId) ?? []) wake(event);
    this.waiters.delete(hook.sessionId);
  }

  public knows(sessionId: string): boolean {
    return this.sessions[sessionId] !== undefined;
  }

  public latest(sessionId: string): SeatEvent | undefined {
    return this.sessions[sessionId]?.last;
  }

  /** The next settled turn this session reports. */
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
        reject(signal?.reason);
      };
      waiters.add(wake);
      this.waiters.set(sessionId, waiters);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private read(): Record<string, HookSession> {
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8")) as { sessions?: unknown };
      return typeof value.sessions === "object" && value.sessions !== null
        ? (value.sessions as Record<string, HookSession>)
        : {};
    } catch {
      return {};
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, sessions: this.sessions })}\n`, {
      mode: 0o600,
    });
    renameSync(temporary, this.path);
  }
}

const INSTALL_FIX = `Install the worker plugin once from Clankie's marketplace, leaving it off by default (each hire enables it for its own session): claude plugin install ${CLAUDE_WORKER_PLUGIN_ID} && claude plugin disable ${CLAUDE_WORKER_PLUGIN_ID}`;
const POLICY_FIX = `Approve its channel once as this Mac's administrator: in ${CLAUDE_MANAGED_SETTINGS}, set "channelsEnabled": true and add { "marketplace": "${CLAUDE_WORKER_PLUGIN.marketplace}", "plugin": "${CLAUDE_WORKER_PLUGIN.plugin}" } to "allowedChannelPlugins", keeping any entries already there (docs/testing/2026-09-26-interactive-swarm-workers/managed-consent.md).`;

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
  let enabled = false;
  let allowed = false;
  for (const file of files) {
    let value: { channelsEnabled?: unknown; allowedChannelPlugins?: unknown };
    try {
      value = JSON.parse(readFileSync(file, "utf8")) as typeof value;
    } catch {
      continue;
    }
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

  public constructor(ref: SeatRef, deps: ClaudeWorkerSeatDeps) {
    this.ref = ref;
    this.deps = deps;
    this.receiptMs = deps.timing?.receiptMs ?? RECEIPT_MS;
    this.pollMs = deps.timing?.pollMs ?? POLL_MS;
  }

  public async status(): Promise<SeatStatus> {
    const agent = await this.deps.agent(this.ref.paneId).catch(() => undefined);
    if (agent === undefined || sessionIdOf(agent) !== this.ref.sessionId) return "offline";
    if (!this.deps.mailbox.bound(agent.terminalId)) return "released";
    return agent.status === "working" ? "working" : agent.status === "blocked" ? "blocked" : "idle";
  }

  public async send(message: string, options?: { readonly timeoutMs?: number }): Promise<SeatDelivery> {
    const agent = await this.deps.agent(this.ref.paneId).catch(() => undefined);
    if (agent === undefined || sessionIdOf(agent) !== this.ref.sessionId)
      return { outcome: "offline", detail: "The seat's Claude session is gone" };
    if (!this.deps.mailbox.bound(agent.terminalId)) return { outcome: "released" };
    const before = await transcriptIds(this.deps, agent);
    const busy = agent.status === "working";
    const delivery = await this.deps.mailbox.deliver(agent.terminalId, message);
    if (typeof delivery !== "boolean") return delivery;
    if (!delivery) return { outcome: "released" };
    const id = await receipt(
      this.deps,
      agent,
      message,
      before,
      options?.timeoutMs ?? this.receiptMs,
      this.pollMs,
    );
    if (id === undefined)
      return {
        outcome: "unconfirmed",
        messageId: "",
        detail: "The worker channel took the message, but it has not appeared in the session transcript",
      };
    return { outcome: "accepted", messageId: id, state: busy ? "queued" : "started" };
  }

  public async settled(signal?: AbortSignal): Promise<SeatEvent> {
    const at = () => new Date().toISOString();
    for (;;) {
      // Listen before looking, so a Stop landing between the two is not lost.
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      const next = this.deps.hooks.next(this.ref.sessionId, controller.signal);
      next.catch(() => undefined);
      try {
        const status = await this.status();
        if (status === "offline") return { type: "exited", at: at(), code: null };
        if (status === "released") return { type: "released", at: at() };
        if (status === "blocked")
          return { type: "blocked", at: at(), reason: "Claude is waiting on the owner in its pane" };
        if (status === "idle") {
          const latest = this.deps.hooks.latest(this.ref.sessionId);
          return latest?.type === "turn_completed" ? latest : { type: "turn_completed", at: at(), ok: true };
        }
        // A Stop hook is the settlement; the status poll catches a prompt or a lost pane meanwhile.
        const settled = await Promise.race([next, sleep(1_000, controller.signal).then(() => undefined)]);
        if (settled !== undefined) return settled;
      } finally {
        controller.abort();
        signal?.removeEventListener("abort", abort);
      }
      signal?.throwIfAborted();
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
      const consent = await deps.consent();
      if (!consent.approved)
        return { outcome: "blocked", reason: "consent_required", detail: consent.detail, fix: consent.fix };
      try {
        await view.start("claude", claudeWorkerLaunchArgs(launch));
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
      if (launch.brief.length > 0) {
        const before = await transcriptIds(deps, agent);
        const taken = await deps.mailbox.deliver(agent.terminalId, launch.brief);
        if (typeof taken !== "boolean")
          return {
            outcome: "failed",
            reason: "not_ready",
            detail: `brief_delivery_unverified: ${JSON.stringify(taken)}`,
          };
        if (!taken) logReceiptRejection(agent, "mailbox_not_delivered");
        const received = taken
          ? await receipt(deps, agent, launch.brief, before, receiptMs, pollMs)
          : undefined;
        if (received === undefined)
          return {
            outcome: "failed",
            reason: "not_ready",
            detail: "brief_delivery_unverified: the complete brief was not observed in the seat transcript",
          };
      }
      deps.hooks.record(view.paneId, { schemaVersion: 1, event: "SessionStart", sessionId });
      return {
        outcome: "started",
        control: new ClaudeWorkerSeatControl({ harness: "claude", sessionId, paneId: view.paneId }, deps),
      };
    },
    async attach(ref): Promise<SeatControl | undefined> {
      if (ref.harness !== "claude" || !deps.hooks.knows(ref.sessionId)) return undefined;
      const control = new ClaudeWorkerSeatControl(ref, deps);
      const status = await control.status();
      return status === "offline" || status === "released" ? undefined : control;
    },
  };
}
