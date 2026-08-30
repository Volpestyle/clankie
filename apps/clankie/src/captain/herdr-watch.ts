import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { redactSensitiveText } from "@clankie/observability";
import {
  OPERATOR_CONVERSATION_SUMMARY_MAX,
  OPERATOR_CONVERSATION_TEXT_MAX,
  type OperatorSeatSpawnResult,
  type SpawnOperatorSeat,
} from "@clankie/protocol";
import { z } from "zod";
import { herdrSummariesPath, readHerdrSummariesFile, type HerdrAgentSummary } from "./herdr-summaries.ts";
import {
  readHerdrSeatTranscript,
  type HerdrAgentSession,
  type HerdrSeatTranscript,
} from "./herdr-transcript.ts";

const HerdrWatchRecordSchema = z
  .object({
    id: z.string().min(1),
    conversationId: z.string().min(1),
    target: z.string().min(1),
    terminalId: z.string().min(1),
    reason: z.string().min(1),
    createdAt: z.string().min(1),
  })
  .strict();

const PersistedHerdrWatchesSchema = z
  .object({
    schemaVersion: z.literal(1),
    watches: z.array(HerdrWatchRecordSchema),
  })
  .strict();

type HerdrWatchRecord = z.infer<typeof HerdrWatchRecordSchema>;
type PersistedHerdrWatches = z.infer<typeof PersistedHerdrWatchesSchema>;

export interface HerdrAgentSnapshot {
  readonly paneId: string;
  readonly terminalId: string;
  readonly agent: string;
  readonly status: string;
  readonly title: string;
  readonly session?: HerdrAgentSession;
}

export interface HerdrWatchRunner {
  get(target: string): Promise<HerdrAgentSnapshot>;
  resolveTerminal(terminalId: string): Promise<HerdrAgentSnapshot | undefined>;
  wait(target: string, signal: AbortSignal): Promise<HerdrAgentSnapshot>;
  waitForChange?(target: string, currentStatus: string, signal: AbortSignal): Promise<HerdrAgentSnapshot>;
  transcript?(agent: HerdrAgentSnapshot): Promise<HerdrSeatTranscript | undefined>;
  read?(target: string, harness: string, source: "visible" | "recent-unwrapped"): Promise<string>;
  sendText?(target: string, text: string): Promise<void>;
  pressEnter?(target: string): Promise<void>;
  closePane?(target: string): Promise<void>;
  /** Open a tab in a working directory; resolves with its root pane id. */
  createTab?(options: { readonly cwd: string; readonly label: string }): Promise<string>;
  /** Start a harness in a pane already sitting at its shell prompt. */
  startAgent?(options: {
    readonly name: string;
    readonly kind: string;
    readonly paneId: string;
  }): Promise<void>;
}

export type HerdrWatchArmResult =
  | {
      readonly outcome: "watching";
      readonly watchId: string;
      readonly target: string;
      readonly paneId: string;
      readonly terminalId: string;
      readonly alreadyWatching: boolean;
      readonly createdAt: string;
    }
  | {
      readonly outcome: "already_settled";
      readonly target: string;
      readonly paneId: string;
      readonly terminalId: string;
      readonly status: string;
    };

export interface HerdrWatchPort {
  watch(conversationId: string, target: string, reason: string): Promise<HerdrWatchArmResult>;
}

type InternalWake = (conversationId: string, prompt: string) => Promise<void>;
type HerdrSeatProjection =
  | { readonly kind: "status"; readonly status: string }
  | { readonly kind: "summary"; readonly text: string }
  | { readonly kind: "reply"; readonly text: string }
  | { readonly kind: "transcript"; readonly transcript: HerdrSeatTranscript };
type ProjectSeat = (seatId: string, projection: HerdrSeatProjection) => void;

const SETTLED_STATUSES = new Set(["idle", "done", "blocked"]);
const REPLY_STATUSES = new Set(["idle", "done"]);
const AGENT_STATUSES = ["idle", "working", "blocked", "done", "unknown"] as const;
const RETRY_ADMISSION_MS = 5_000;
const HERDR_COMMAND_TIMEOUT_MS = 5_000;
const SEAT_REPLY_READ_LINES = 240;
const PI_ZONE_START = "\u001B]133;A\u0007";
const PI_ZONE_END = "\u001B]133;B\u0007\u001B]133;C\u0007";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function titleOf(agent: Record<string, unknown>): string {
  for (const key of ["title", "terminal_title_stripped", "terminal_title"] as const) {
    const value = agent[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

function snapshotOf(value: unknown): HerdrAgentSnapshot {
  if (!isRecord(value)) throw new Error("Herdr response did not include an agent");
  const paneId = value.pane_id;
  const terminalId = value.terminal_id;
  if (typeof paneId !== "string" || typeof terminalId !== "string") {
    throw new Error("Herdr response did not identify the agent pane");
  }
  const rawSession = isRecord(value.agent_session) ? value.agent_session : undefined;
  const session: HerdrAgentSession | undefined =
    typeof rawSession?.source === "string" &&
    (rawSession.kind === "id" || rawSession.kind === "path") &&
    typeof rawSession.value === "string"
      ? { source: rawSession.source, kind: rawSession.kind, value: rawSession.value }
      : undefined;
  return {
    paneId,
    terminalId,
    agent: typeof value.agent === "string" ? value.agent : "unknown",
    status: typeof value.agent_status === "string" ? value.agent_status : "unknown",
    title: titleOf(value),
    ...(session === undefined ? {} : { session }),
  };
}

export function parseHerdrAgentResult(stdout: string): HerdrAgentSnapshot {
  const parsed = JSON.parse(stdout) as { result?: { agent?: unknown } };
  return snapshotOf(parsed.result?.agent);
}

export function parseHerdrForegroundProcessId(stdout: string): number | undefined {
  const parsed: unknown = JSON.parse(stdout);
  const result = isRecord(parsed) ? parsed.result : undefined;
  const processInfo = isRecord(result) ? result.process_info : undefined;
  const processes =
    isRecord(processInfo) && Array.isArray(processInfo.foreground_processes)
      ? processInfo.foreground_processes
      : [];
  const process = processes.find(isRecord);
  return process !== undefined && typeof process.pid === "number" ? process.pid : undefined;
}

function parseHerdrPaneList(stdout: string): HerdrAgentSnapshot[] {
  const parsed = JSON.parse(stdout) as { result?: { panes?: unknown } };
  const panes = Array.isArray(parsed.result?.panes) ? parsed.result.panes : [];
  return panes.map(snapshotOf);
}

function runHerdr(args: readonly string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "herdr",
      [...args],
      {
        maxBuffer: 1024 * 1024,
        ...(signal === undefined ? { timeout: HERDR_COMMAND_TIMEOUT_MS } : { signal }),
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          if (signal?.aborted === true) {
            reject(error);
            return;
          }
          reject(new Error(String(stderr).trim() || error.message));
          return;
        }
        resolve(String(stdout));
      },
    );
  });
}

function defaultRunner(): HerdrWatchRunner {
  return {
    get: async (target) => parseHerdrAgentResult(await runHerdr(["agent", "get", target])),
    resolveTerminal: async (terminalId) =>
      parseHerdrPaneList(await runHerdr(["pane", "list"])).find((pane) => pane.terminalId === terminalId),
    wait: async (target, signal) => parseHerdrAgentResult(await runHerdr(["agent", "wait", target], signal)),
    waitForChange: async (target, currentStatus, signal) =>
      parseHerdrAgentResult(
        await runHerdr(
          [
            "agent",
            "wait",
            target,
            ...AGENT_STATUSES.filter((status) => status !== currentStatus).flatMap((status) => [
              "--until",
              status,
            ]),
          ],
          signal,
        ),
      ),
    transcript: async (agent) => {
      const processId =
        agent.agent === "grok" && agent.session === undefined
          ? parseHerdrForegroundProcessId(await runHerdr(["pane", "process-info", "--pane", agent.paneId]))
          : undefined;
      return readHerdrSeatTranscript(agent.agent, agent.session, processId);
    },
    read: (target, harness, source) =>
      runHerdr([
        "agent",
        "read",
        target,
        "--source",
        source,
        ...(source === "visible" ? [] : ["--lines", String(SEAT_REPLY_READ_LINES)]),
        ...(harness === "pi" ? ["--format", "ansi"] : []),
      ]),
    sendText: (target, text) => runHerdr(["pane", "send-text", target, text]).then(() => undefined),
    pressEnter: (target) => runHerdr(["pane", "send-keys", target, "Enter"]).then(() => undefined),
    closePane: (target) => runHerdr(["pane", "close", target]).then(() => undefined),
    createTab: async ({ cwd, label }) =>
      parseHerdrRootPaneId(
        await runHerdr(["tab", "create", "--cwd", cwd, "--label", label, "--no-focus"]),
      ),
    startAgent: ({ name, kind, paneId }) =>
      // Returns only once herdr has detected the harness and considers it ready
      // for input, so a resolved call means the seat can actually be messaged.
      runHerdr(["agent", "start", name, "--kind", kind, "--pane", paneId]).then(() => undefined),
  };
}

function reasonDetail(caught: unknown): string {
  return caught instanceof Error ? caught.message.slice(0, OPERATOR_CONVERSATION_SUMMARY_MAX) : "";
}

/**
 * Herdr reports startup trouble in its stderr text, so the outcome is read off
 * it. Anything unrecognised is `not_ready`: the pane was opened and the harness
 * did not come up, which is what the operator needs to know either way.
 */
function spawnFailureReason(detail: string): "harness_unavailable" | "not_ready" {
  return /not found|no such file|unsupported|not installed|unknown kind/iu.test(detail)
    ? "harness_unavailable"
    : "not_ready";
}

function parseHerdrRootPaneId(stdout: string): string {
  const parsed = JSON.parse(stdout) as { result?: { root_pane?: unknown } };
  const rootPane = parsed.result?.root_pane;
  const paneId = isRecord(rootPane) ? rootPane.pane_id : undefined;
  if (typeof paneId !== "string" || paneId.length === 0) {
    throw new Error("Herdr created a tab without a pane");
  }
  return paneId;
}

/**
 * Herdr agent names are `[a-z][a-z0-9_-]{0,31}` and must be unique among live
 * agents, so the operator's free-text title has to become one. `agent list`
 * does not surface names, so uniqueness cannot be checked — it is made, with a
 * short suffix. The operator never types this; it is the roster title that
 * carries their words.
 */
export function herdrAgentName(title: string, suffix: string = randomUUID().slice(0, 4)): string {
  const slug = title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replace(/^[^a-z]+/u, "")
    .replace(/-+$/u, "");
  const base = (slug.length === 0 ? "agent" : slug).slice(0, 32 - suffix.length - 1);
  return `${base}-${suffix}`;
}

/** Persisted, event-driven one-shot watches that wake an operator conversation when an agent settles. */
export class HerdrWatchStore implements HerdrWatchPort {
  private readonly path: string;
  private readonly runner: HerdrWatchRunner;
  private readonly controllers = new Map<string, AbortController>();
  private readonly seatControllers = new Map<string, AbortController>();
  private readonly seatStatuses = new Map<string, string>();
  private readonly seatSummaries = new Map<string, string>();
  private readonly transcriptSeats = new Set<string>();
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private readonly summariesPath: string;
  private readonly summaryWatchIntervalMs: number;
  private state: PersistedHerdrWatches;
  private wake: InternalWake | undefined;
  private projectSeat: ProjectSeat | undefined;
  private watchingSummaries = false;
  private stateUnreadable = false;
  private closed = false;

  public constructor(
    path: string,
    options: {
      readonly runner?: HerdrWatchRunner;
      readonly summariesPath?: string;
      readonly summaryWatchIntervalMs?: number;
    } = {},
  ) {
    this.path = path;
    this.runner = options.runner ?? defaultRunner();
    this.summariesPath = options.summariesPath ?? herdrSummariesPath();
    this.summaryWatchIntervalMs = options.summaryWatchIntervalMs ?? 1_000;
    this.state = this.read();
  }

  public start(wake: InternalWake, projectSeat?: ProjectSeat): void {
    this.wake = wake;
    this.projectSeat = projectSeat;
    for (const watch of this.state.watches) this.launch(watch);
  }

  public async sendToSeat(seatId: string, text: string): Promise<boolean> {
    if (this.closed || this.runner.sendText === undefined || this.runner.pressEnter === undefined)
      return false;
    try {
      const current = await this.runner.resolveTerminal(seatId);
      if (!isMessageableSeat(current)) return false;
      await this.runner.sendText(current.paneId, text);
      const submitted = await this.runner.resolveTerminal(seatId);
      if (!isMessageableSeat(submitted)) return false;
      await this.runner.pressEnter(submitted.paneId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Hire an agent (ADR 0013): a tab in the chosen directory, a harness started
   * in it, and the seat it became. Every failure is an outcome rather than a
   * throw — the surface renders "couldn't hire" and keeps the operator's draft.
   *
   * A start that fails leaves no stray tab behind: the pane opened for it is
   * closed on the way out, so a retry does not accumulate empty shells.
   */
  public async spawnSeat(input: SpawnOperatorSeat): Promise<OperatorSeatSpawnResult> {
    const { createTab, startAgent } = this.runner;
    if (this.closed || createTab === undefined || startAgent === undefined) {
      return { outcome: "failed", reason: "herdr_unreachable" };
    }
    // The captain runs on the machine herdr does, so this is the real check —
    // and a missing path is the one failure worth naming precisely, because it
    // is the one the operator can fix from the compose page.
    if (!existsSync(input.workingDirectory)) {
      return { outcome: "failed", reason: "unknown_directory", detail: input.workingDirectory };
    }
    let paneId: string;
    try {
      paneId = await createTab({ cwd: input.workingDirectory, label: input.title });
    } catch (caught) {
      return { outcome: "failed", reason: "herdr_unreachable", detail: reasonDetail(caught) };
    }
    try {
      await startAgent({ name: herdrAgentName(input.title), kind: input.harness, paneId });
      const agent = await this.runner.get(paneId);
      return {
        outcome: "spawned",
        seat: {
          seatId: agent.terminalId,
          harness: agent.agent,
          status: agent.status,
          title: agent.title || input.title,
          workingDirectory: input.workingDirectory,
        },
      };
    } catch (caught) {
      await this.runner.closePane?.(paneId).catch(() => undefined);
      const detail = reasonDetail(caught);
      return { outcome: "failed", reason: spawnFailureReason(detail), detail };
    }
  }

  public async closeSeat(seatId: string): Promise<boolean> {
    if (this.closed || this.runner.closePane === undefined) return false;
    try {
      const current = await this.runner.resolveTerminal(seatId);
      if (current === undefined) return false;
      await this.runner.closePane(current.paneId);
      return true;
    } catch {
      return false;
    }
  }

  public trackSeat(seatId: string): void {
    if (this.closed || this.projectSeat === undefined || this.seatControllers.has(seatId)) return;
    const controller = new AbortController();
    this.seatControllers.set(seatId, controller);
    this.ensureSummaryWatch();
    void this.runSeat(seatId, controller.signal).finally(() => {
      if (this.seatControllers.get(seatId) === controller) this.seatControllers.delete(seatId);
      if (this.seatControllers.size === 0) this.stopSummaryWatch();
    });
  }

  public untrackSeat(seatId: string): void {
    this.seatControllers.get(seatId)?.abort();
    this.seatControllers.delete(seatId);
    this.seatStatuses.delete(seatId);
    this.seatSummaries.delete(seatId);
    this.transcriptSeats.delete(seatId);
    if (this.seatControllers.size === 0) this.stopSummaryWatch();
  }

  public async watch(conversationId: string, target: string, reason: string): Promise<HerdrWatchArmResult> {
    if (this.closed || this.wake === undefined) throw new Error("Herdr watcher is not running");
    if (this.stateUnreadable) throw new Error("Herdr watcher state is unreadable");
    const agent = await this.runner.get(target);
    if (SETTLED_STATUSES.has(agent.status)) {
      return {
        outcome: "already_settled",
        target,
        paneId: agent.paneId,
        terminalId: agent.terminalId,
        status: agent.status,
      };
    }
    if (agent.status !== "working") {
      throw new Error(`Herdr pane ${target} has no working agent to watch (status ${agent.status})`);
    }
    const existing = this.state.watches.find(
      (watch) => watch.conversationId === conversationId && watch.terminalId === agent.terminalId,
    );
    if (existing !== undefined) {
      return {
        outcome: "watching",
        watchId: existing.id,
        target: existing.target,
        paneId: agent.paneId,
        terminalId: agent.terminalId,
        alreadyWatching: true,
        createdAt: existing.createdAt,
      };
    }
    const record: HerdrWatchRecord = {
      id: randomUUID(),
      conversationId,
      target,
      terminalId: agent.terminalId,
      reason: reason.trim(),
      createdAt: new Date().toISOString(),
    };
    this.state.watches.push(record);
    this.save();
    this.launch(record);
    return {
      outcome: "watching",
      watchId: record.id,
      target,
      paneId: agent.paneId,
      terminalId: agent.terminalId,
      alreadyWatching: false,
      createdAt: record.createdAt,
    };
  }

  public cancelConversation(conversationId: string): void {
    const removed = this.state.watches.filter((watch) => watch.conversationId === conversationId);
    if (removed.length === 0) return;
    this.state.watches = this.state.watches.filter((watch) => watch.conversationId !== conversationId);
    for (const watch of removed) this.controllers.get(watch.id)?.abort();
    this.save();
  }

  public close(): void {
    this.closed = true;
    this.wake = undefined;
    this.projectSeat = undefined;
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    for (const controller of this.seatControllers.values()) controller.abort();
    this.seatControllers.clear();
    this.transcriptSeats.clear();
    this.stopSummaryWatch();
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
  }

  private async runSeat(seatId: string, signal: AbortSignal): Promise<void> {
    let seeded = false;
    while (!signal.aborted) {
      try {
        const current = await this.runner.resolveTerminal(seatId);
        if (!isMessageableSeat(current)) {
          this.publishSeatStatus(seatId, "offline");
          await delay(RETRY_ADMISSION_MS);
          continue;
        }
        const hasTranscript = await this.publishSeatTranscript(seatId, current);
        // Publish status after the one-time transcript migration so the current
        // typing/delivery state remains the newest durable event.
        this.publishSeatStatus(seatId, current.status);
        if (!hasTranscript) {
          this.publishSeatSummary(seatId, current.paneId, readHerdrSummariesFile(this.summariesPath).agents);
        }
        // Seed the thread with the pane's last settled answer so a freshly
        // opened seat conversation starts with what the agent already said.
        // The registry dedups an identical re-projection (restart, re-track).
        if (!hasTranscript && !seeded && REPLY_STATUSES.has(current.status)) {
          const reply = await this.readSeatReply(current, "recent-unwrapped");
          if (reply !== undefined) this.projectSeat?.(seatId, { kind: "reply", text: reply });
        }
        seeded = true;
        if (this.runner.waitForChange === undefined) return;
        const piBaseline =
          current.status === "working" && current.agent === "pi"
            ? await this.readSeatReply(current, "visible")
            : undefined;
        const changed = await this.runner.waitForChange(current.paneId, current.status, signal);
        if (current.status === "working" && REPLY_STATUSES.has(changed.status)) {
          const changedHasTranscript = await this.publishSeatTranscript(seatId, changed);
          const reply = changedHasTranscript
            ? undefined
            : await this.readSeatReply(changed, "recent-unwrapped");
          if (
            reply !== undefined &&
            (changed.agent !== "pi" || (piBaseline !== undefined && reply !== piBaseline))
          ) {
            this.projectSeat?.(seatId, { kind: "reply", text: reply });
          }
        }
      } catch {
        if (signal.aborted) return;
        this.publishSeatStatus(seatId, "offline");
        await delay(RETRY_ADMISSION_MS);
      }
    }
  }

  private async publishSeatTranscript(seatId: string, agent: HerdrAgentSnapshot): Promise<boolean> {
    if (this.runner.transcript === undefined) return false;
    try {
      const transcript = await this.runner.transcript(agent);
      if (transcript === undefined) {
        this.transcriptSeats.delete(seatId);
        return false;
      }
      this.transcriptSeats.add(seatId);
      this.projectSeat?.(seatId, { kind: "transcript", transcript });
      return true;
    } catch {
      this.transcriptSeats.delete(seatId);
      return false;
    }
  }

  private async readSeatReply(
    agent: HerdrAgentSnapshot,
    source: "visible" | "recent-unwrapped",
  ): Promise<string | undefined> {
    if (this.runner.read === undefined) return undefined;
    try {
      return distillHerdrSeatReply(agent.agent, await this.runner.read(agent.paneId, agent.agent, source));
    } catch {
      return undefined;
    }
  }

  private publishSeatStatus(seatId: string, status: string): void {
    if (this.seatStatuses.get(seatId) === status) return;
    this.seatStatuses.set(seatId, status);
    this.projectSeat?.(seatId, { kind: "status", status });
  }

  private publishSeatSummary(
    seatId: string,
    paneId: string,
    summaries: Readonly<Record<string, HerdrAgentSummary>>,
  ): void {
    const raw = summaries[paneId]?.summary;
    const text =
      raw === undefined
        ? undefined
        : bounded(
            redactSensitiveText(stripVTControlCharacters(raw).trim()),
            OPERATOR_CONVERSATION_SUMMARY_MAX,
          );
    if (text === undefined) {
      this.seatSummaries.delete(seatId);
      return;
    }
    if (this.seatSummaries.get(seatId) === text) return;
    this.seatSummaries.set(seatId, text);
    this.projectSeat?.(seatId, { kind: "summary", text });
  }

  private ensureSummaryWatch(): void {
    if (this.watchingSummaries) return;
    watchFile(
      this.summariesPath,
      { interval: this.summaryWatchIntervalMs, persistent: false },
      this.onSummariesChanged,
    );
    this.watchingSummaries = true;
  }

  private stopSummaryWatch(): void {
    if (!this.watchingSummaries) return;
    unwatchFile(this.summariesPath, this.onSummariesChanged);
    this.watchingSummaries = false;
  }

  private readonly onSummariesChanged = (): void => {
    const summaries = readHerdrSummariesFile(this.summariesPath).agents;
    for (const seatId of this.seatControllers.keys()) {
      if (this.transcriptSeats.has(seatId)) continue;
      void this.runner
        .resolveTerminal(seatId)
        .then((current) => {
          if (this.seatControllers.has(seatId) && isMessageableSeat(current)) {
            this.publishSeatSummary(seatId, current.paneId, summaries);
          }
        })
        .catch(() => undefined);
    }
  };

  private launch(record: HerdrWatchRecord): void {
    if (this.closed || this.wake === undefined || this.controllers.has(record.id)) return;
    const controller = new AbortController();
    this.controllers.set(record.id, controller);
    void this.run(record, controller.signal).finally(() => this.controllers.delete(record.id));
  }

  private async run(record: HerdrWatchRecord, signal: AbortSignal): Promise<void> {
    let prompt: string;
    try {
      const current = await this.runner.resolveTerminal(record.terminalId);
      if (current === undefined || current.status === "unknown") {
        prompt = watchPrompt(record, current, "The watched pane is gone.");
      } else {
        const settled = SETTLED_STATUSES.has(current.status)
          ? current
          : await this.runner.wait(current.paneId, signal);
        prompt = watchPrompt(record, settled);
      }
    } catch (caught) {
      if (signal.aborted) return;
      prompt = watchPrompt(
        record,
        undefined,
        `The watcher failed before it observed completion: ${caught instanceof Error ? caught.message : String(caught)}`,
      );
    }
    if (signal.aborted) return;
    try {
      await this.wake?.(record.conversationId, prompt);
      this.remove(record.id);
    } catch {
      if (this.closed) return;
      const timer = setTimeout(() => {
        this.retryTimers.delete(timer);
        this.launch(record);
      }, RETRY_ADMISSION_MS);
      timer.unref?.();
      this.retryTimers.add(timer);
    }
  }

  private remove(id: string): void {
    const next = this.state.watches.filter((watch) => watch.id !== id);
    if (next.length === this.state.watches.length) return;
    this.state.watches = next;
    this.save();
  }

  private read(): PersistedHerdrWatches {
    if (!existsSync(this.path)) return { schemaVersion: 1, watches: [] };
    try {
      return PersistedHerdrWatchesSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
    } catch {
      this.stateUnreadable = true;
      return { schemaVersion: 1, watches: [] };
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, this.path);
    this.stateUnreadable = false;
  }
}

function watchPrompt(record: HerdrWatchRecord, agent?: HerdrAgentSnapshot, failure?: string): string {
  const observation =
    failure ??
    `The watched pane settled with agent status ${agent?.status ?? "unknown"} (${agent?.paneId ?? record.target}, ${agent?.agent ?? "unknown agent"}${agent?.title ? `, ${agent.title}` : ""}).`;
  return [
    "This is a Herdr watcher notification you armed earlier, not a new instruction from the owner.",
    `Reason you recorded: ${record.reason}`,
    observation,
    "Inspect the pane and its side effects now. A settled status is a cue to harvest, not proof that the work is correct. Do not replace this watcher with timed polling.",
  ].join("\n\n");
}

function bounded(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Returns only a harness-recognized final reply; unrecognized scrollback is never projected. */
export function distillHerdrSeatReply(harness: string, transcript: string): string | undefined {
  const candidate =
    harness === "claude"
      ? claudeReply(transcript)
      : harness === "codex"
        ? codexReply(transcript)
        : harness === "pi"
          ? piReply(transcript)
          : undefined;
  if (candidate === undefined) return undefined;
  const text = stripVTControlCharacters(candidate.replace(/\r\n?/gu, "\n"))
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  if (text.length === 0) return undefined;
  return bounded(redactSensitiveText(text), OPERATOR_CONVERSATION_TEXT_MAX);
}

function claudeReply(transcript: string): string | undefined {
  const lines = stripVTControlCharacters(transcript).replace(/\r\n?/gu, "\n").split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = /^\s*※\s*recap:\s*(.+?)\s*$/iu.exec(lines[index] ?? "");
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function codexReply(transcript: string): string | undefined {
  const lines = stripVTControlCharacters(transcript).replace(/\r\n?/gu, "\n").split("\n");
  const footer = lines.findLastIndex((line) => /^\s*─+\s*Worked for\b/u.test(line));
  if (footer < 0) return undefined;
  let separator = footer - 1;
  while (separator >= 0 && !/^\s*─{8,}\s*$/u.test(lines[separator] ?? "")) separator -= 1;
  if (separator < 0) return undefined;
  const reply = lines.slice(separator + 1, footer);
  while (reply[0]?.trim().length === 0) reply.shift();
  while (reply.at(-1)?.trim().length === 0) reply.pop();
  if (!/^\s*•(?:\s|$)/u.test(reply[0] ?? "")) return undefined;
  reply[0] = (reply[0] ?? "").replace(/^\s*•\s?/u, "");
  for (let index = 1; index < reply.length; index += 1) {
    if (reply[index]?.startsWith("  ")) reply[index] = reply[index]!.slice(2);
  }
  return reply.join("\n");
}

function piReply(transcript: string): string | undefined {
  const start = transcript.lastIndexOf(PI_ZONE_START);
  if (start < 0) return undefined;
  const lineStart = transcript.lastIndexOf("\n", start) + 1;
  const end = transcript.indexOf(PI_ZONE_END, start + PI_ZONE_START.length);
  if (end < 0 && !transcript.slice(lineStart, start).endsWith(PI_ZONE_END)) return undefined;
  const lineEnd = transcript.indexOf("\n", end < 0 ? start : end);
  const candidate = transcript.slice(start + PI_ZONE_START.length, lineEnd < 0 ? transcript.length : lineEnd);
  return candidate
    .replaceAll(PI_ZONE_END, "")
    .split("\n")
    .map((line) => (line.startsWith(" ") ? line.slice(1) : line))
    .join("\n");
}

function isMessageableSeat(agent: HerdrAgentSnapshot | undefined): agent is HerdrAgentSnapshot {
  return agent !== undefined && agent.agent !== "shell" && agent.agent !== "unknown";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
