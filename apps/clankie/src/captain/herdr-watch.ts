import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

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

const SETTLED_STATUSES = new Set(["idle", "done", "blocked"]);
const RETRY_ADMISSION_MS = 5_000;

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
      { maxBuffer: 1024 * 1024, ...(signal === undefined ? {} : { signal }) },
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
  };
}

/** Persisted, event-driven one-shot watches that wake an operator conversation when an agent settles. */
export class HerdrWatchStore implements HerdrWatchPort {
  private readonly path: string;
  private readonly runner: HerdrWatchRunner;
  private readonly controllers = new Map<string, AbortController>();
  private readonly retryTimers = new Set<ReturnType<typeof setTimeout>>();
  private state: PersistedHerdrWatches;
  private wake: InternalWake | undefined;
  private stateUnreadable = false;
  private closed = false;

  public constructor(path: string, options: { readonly runner?: HerdrWatchRunner } = {}) {
    this.path = path;
    this.runner = options.runner ?? defaultRunner();
    this.state = this.read();
  }

  public start(wake: InternalWake): void {
    this.wake = wake;
    for (const watch of this.state.watches) this.launch(watch);
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
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
  }

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
