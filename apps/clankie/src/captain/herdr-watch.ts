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
import { OPERATOR_CONVERSATION_SUMMARY_MAX } from "@clankie/protocol";
import { z } from "zod";
import { herdrSummariesPath, readHerdrSummariesFile, type HerdrAgentSummary } from "./herdr-summaries.ts";

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
}

export interface HerdrWatchRunner {
  get(target: string): Promise<HerdrAgentSnapshot>;
  resolveTerminal(terminalId: string): Promise<HerdrAgentSnapshot | undefined>;
  wait(target: string, signal: AbortSignal): Promise<HerdrAgentSnapshot>;
  waitForChange?(target: string, currentStatus: string, signal: AbortSignal): Promise<HerdrAgentSnapshot>;
  sendText?(target: string, text: string): Promise<void>;
  pressEnter?(target: string): Promise<void>;
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
  | { readonly kind: "summary"; readonly text: string };
type ProjectSeat = (seatId: string, projection: HerdrSeatProjection) => void;

const SETTLED_STATUSES = new Set(["idle", "done", "blocked"]);
const AGENT_STATUSES = ["idle", "working", "blocked", "done", "unknown"] as const;
const RETRY_ADMISSION_MS = 5_000;
const HERDR_COMMAND_TIMEOUT_MS = 5_000;

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
  return {
    paneId,
    terminalId,
    agent: typeof value.agent === "string" ? value.agent : "unknown",
    status: typeof value.agent_status === "string" ? value.agent_status : "unknown",
    title: titleOf(value),
  };
}

export function parseHerdrAgentResult(stdout: string): HerdrAgentSnapshot {
  const parsed = JSON.parse(stdout) as { result?: { agent?: unknown } };
  return snapshotOf(parsed.result?.agent);
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
    sendText: (target, text) => runHerdr(["pane", "send-text", target, text]).then(() => undefined),
    pressEnter: (target) => runHerdr(["pane", "send-keys", target, "Enter"]).then(() => undefined),
  };
}

/** Persisted, event-driven one-shot watches that wake an operator conversation when an agent settles. */
export class HerdrWatchStore implements HerdrWatchPort {
  private readonly path: string;
  private readonly runner: HerdrWatchRunner;
  private readonly controllers = new Map<string, AbortController>();
  private readonly seatControllers = new Map<string, AbortController>();
  private readonly seatStatuses = new Map<string, string>();
  private readonly seatSummaries = new Map<string, string>();
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
    this.stopSummaryWatch();
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
  }

  private async runSeat(seatId: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const current = await this.runner.resolveTerminal(seatId);
        if (!isMessageableSeat(current)) {
          this.publishSeatStatus(seatId, "offline");
          await delay(RETRY_ADMISSION_MS);
          continue;
        }
        this.publishSeatStatus(seatId, current.status);
        this.publishSeatSummary(seatId, current.paneId, readHerdrSummariesFile(this.summariesPath).agents);
        if (this.runner.waitForChange === undefined) return;
        await this.runner.waitForChange(current.paneId, current.status, signal);
      } catch {
        if (signal.aborted) return;
        this.publishSeatStatus(seatId, "offline");
        await delay(RETRY_ADMISSION_MS);
      }
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
        : bounded(stripVTControlCharacters(raw).trim(), OPERATOR_CONVERSATION_SUMMARY_MAX);
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

function isMessageableSeat(agent: HerdrAgentSnapshot | undefined): agent is HerdrAgentSnapshot {
  return agent !== undefined && agent.agent !== "shell" && agent.agent !== "unknown";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
