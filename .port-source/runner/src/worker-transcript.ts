import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  WORKER_TRANSCRIPT_SCHEMA_VERSION,
  WorkerTranscriptCursorExpiredSchema,
  WorkerTranscriptEntrySchema,
  WorkerTranscriptNotFoundSchema,
  WorkerTranscriptRunReplacedSchema,
  WorkerTranscriptSnapshotSchema,
  WorkerTranscriptTailLineSchema,
  type WorkerTranscriptCursorExpired,
  type WorkerTranscriptEntry,
  type WorkerTranscriptKey,
  type WorkerTranscriptNotFound,
  type WorkerTranscriptRedactionClass,
  type WorkerTranscriptRunReplaced,
  type WorkerTranscriptSnapshot,
  type WorkerTranscriptTailLine,
} from "@clankie/protocol";
import { replacePrivateFileAtomically } from "./private-artifact.ts";

const PRIVATE_UPDATE = "[redacted private worker update]";

export interface WorkerTranscriptCandidate {
  key: WorkerTranscriptKey;
  occurredAt: string;
  correlationId: string;
  profileHash: string;
  sourceEventId: string;
  source: "runner_event" | "runner_settlement" | "worker_summary";
  trust: "runner_observed" | "worker_authored";
  kind: WorkerTranscriptEntry["kind"];
  /** Untrusted until projected. This object is never serialized directly. */
  data: Record<string, unknown>;
}

export type WorkerTranscriptTailOpen =
  | { outcome: "tail"; stream: AsyncIterable<WorkerTranscriptTailLine> }
  | WorkerTranscriptCursorExpired
  | WorkerTranscriptRunReplaced
  | WorkerTranscriptNotFound;

interface RunProjection {
  key: WorkerTranscriptKey;
  generation: string;
  path: string;
  entries: WorkerTranscriptEntry[];
}

interface CursorPayload {
  g: string;
  s: number;
}

/**
 * Runner authority for the garden-safe worker transcript. All untrusted input
 * is reduced to a closed entry shape before the first persistence call.
 */
export class WorkerTranscriptProjection {
  private readonly root: string;
  private readonly maxEntriesPerRun: number;
  private readonly runs = new Map<string, RunProjection>();
  private readonly latestByTask = new Map<string, string>();
  private readonly subscribers = new Map<string, Set<AsyncQueue<WorkerTranscriptTailLine>>>();
  private serialized: Promise<unknown> = Promise.resolve();

  private constructor(root: string, maxEntriesPerRun: number) {
    this.root = resolve(root);
    this.maxEntriesPerRun = maxEntriesPerRun;
  }

  public static async open(
    root: string,
    options: { maxEntriesPerRun?: number } = {},
  ): Promise<WorkerTranscriptProjection> {
    const maximum = options.maxEntriesPerRun ?? 500;
    if (!Number.isInteger(maximum) || maximum < 1) {
      throw new Error("worker transcript retention must be a positive integer");
    }
    const projection = new WorkerTranscriptProjection(root, maximum);
    await projection.rebuild();
    return projection;
  }

  public append(candidate: WorkerTranscriptCandidate): Promise<WorkerTranscriptEntry> {
    const operation = this.serialized.then(() => this.appendSerialized(candidate));
    this.serialized = operation.catch(() => undefined);
    return operation;
  }

  public snapshot(
    key: WorkerTranscriptKey,
  ): WorkerTranscriptSnapshot | WorkerTranscriptRunReplaced | WorkerTranscriptNotFound {
    const replacement = this.replacementFor(key);
    if (replacement) return replacement;
    const run = this.runs.get(keyId(key));
    if (!run) return WorkerTranscriptNotFoundSchema.parse({ schemaVersion: 1, outcome: "not_found" });
    return snapshotFor(run);
  }

  public openTail(key: WorkerTranscriptKey, cursor: string, signal: AbortSignal): WorkerTranscriptTailOpen {
    const replacement = this.replacementFor(key);
    if (replacement) return replacement;
    const run = this.runs.get(keyId(key));
    if (!run) return WorkerTranscriptNotFoundSchema.parse({ schemaVersion: 1, outcome: "not_found" });
    const parsed = parseCursor(cursor);
    const retainedFromSequence = run.entries[0]?.sequence ?? 1;
    const latestSequence = run.entries.at(-1)?.sequence ?? 0;
    if (
      !parsed ||
      parsed.g !== run.generation ||
      parsed.s < retainedFromSequence - 1 ||
      parsed.s > latestSequence
    ) {
      return WorkerTranscriptCursorExpiredSchema.parse({
        schemaVersion: 1,
        outcome: "cursor_expired",
        retainedFromSequence,
        snapshotCursor: cursorFor(run.generation, latestSequence),
      });
    }
    return { outcome: "tail", stream: this.tailStream(run, parsed.s, signal) };
  }

  private async appendSerialized(candidate: WorkerTranscriptCandidate): Promise<WorkerTranscriptEntry> {
    const id = keyId(candidate.key);
    let run = this.runs.get(id);
    let newRun = false;
    if (!run) {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      run = {
        key: structuredClone(candidate.key),
        generation: generationFor(candidate.key),
        path: resolve(this.root, `${id}.ndjson`),
        entries: [],
      };
      this.runs.set(id, run);
      newRun = true;
    }
    const existing = run.entries.find(
      (entry) => entry.provenance.sourceEventId === boundedIdentifier(candidate.sourceEventId),
    );
    if (existing) {
      const replayed = redactCandidate(candidate, existing.sequence);
      if (JSON.stringify(replayed) !== JSON.stringify(existing)) {
        throw new Error("worker_transcript_source_event_conflict");
      }
      return structuredClone(existing);
    }
    const sequence = (run.entries.at(-1)?.sequence ?? 0) + 1;
    const entry = redactCandidate(candidate, sequence);
    run.entries.push(entry);
    if (run.entries.length > this.maxEntriesPerRun) {
      run.entries.splice(0, run.entries.length - this.maxEntriesPerRun);
    }
    await persist(run);
    const task = taskKey(candidate.key);
    const prior = this.latestByTask.get(task);
    if (!prior || prior === id || (newRun && compareRuns(this.runs.get(prior), run) < 0)) {
      this.latestByTask.set(task, id);
    }
    const line = tailLine(run, entry);
    for (const subscriber of this.subscribers.get(id) ?? []) subscriber.push(line);
    return structuredClone(entry);
  }

  private async *tailStream(
    run: RunProjection,
    afterSequence: number,
    signal: AbortSignal,
  ): AsyncIterable<WorkerTranscriptTailLine> {
    const id = keyId(run.key);
    const queue = new AsyncQueue<WorkerTranscriptTailLine>();
    let subscribers = this.subscribers.get(id);
    if (!subscribers) {
      subscribers = new Set();
      this.subscribers.set(id, subscribers);
    }
    subscribers.add(queue);
    const abort = () => queue.close();
    signal.addEventListener("abort", abort, { once: true });
    try {
      let delivered = afterSequence;
      for (const entry of run.entries) {
        if (entry.sequence <= delivered) continue;
        delivered = entry.sequence;
        yield tailLine(run, entry);
      }
      for await (const line of queue) {
        if (line.entry.sequence <= delivered) continue;
        delivered = line.entry.sequence;
        yield line;
      }
    } finally {
      signal.removeEventListener("abort", abort);
      subscribers.delete(queue);
      if (subscribers.size === 0) this.subscribers.delete(id);
    }
  }

  private replacementFor(key: WorkerTranscriptKey): WorkerTranscriptRunReplaced | undefined {
    const latestId = this.latestByTask.get(taskKey(key));
    if (!latestId || latestId === keyId(key)) return undefined;
    const replacement = this.runs.get(latestId);
    if (!replacement) return undefined;
    return WorkerTranscriptRunReplacedSchema.parse({
      schemaVersion: WORKER_TRANSCRIPT_SCHEMA_VERSION,
      outcome: "run_replaced",
      replacementKey: replacement.key,
      snapshotCursor: cursorFor(replacement.generation, replacement.entries.at(-1)?.sequence ?? 0),
    });
  }

  private async rebuild(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const files = (await readdir(this.root)).filter((name) => name.endsWith(".ndjson")).sort();
    for (const file of files) {
      const path = resolve(this.root, file);
      const entries = (await readFile(path, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => WorkerTranscriptEntrySchema.parse(JSON.parse(line)));
      if (entries.length === 0) continue;
      validateReplay(entries);
      const first = entries[0] as WorkerTranscriptEntry;
      const key = { missionId: first.missionId, taskId: first.taskId, workerRunId: first.workerRunId };
      const id = keyId(key);
      if (file !== `${id}.ndjson`) throw new Error("worker_transcript_path_identity_mismatch");
      const run = { key, generation: generationFor(key), path, entries };
      this.runs.set(id, run);
      const task = taskKey(key);
      const prior = this.latestByTask.get(task);
      if (!prior || compareRuns(this.runs.get(prior), run) < 0) this.latestByTask.set(task, id);
    }
  }
}

function redactCandidate(candidate: WorkerTranscriptCandidate, sequence: number): WorkerTranscriptEntry {
  const classes = new Set<WorkerTranscriptRedactionClass>();
  classifyDiscarded(candidate.data, classes);
  const base = {
    schemaVersion: WORKER_TRANSCRIPT_SCHEMA_VERSION,
    entryId: `${candidate.key.workerRunId}:${sequence}`,
    ...candidate.key,
    sequence,
    occurredAt: candidate.occurredAt,
    correlationId: candidate.correlationId,
    profileHash: candidate.profileHash,
    visibility: "garden" as const,
    provenance: {
      source: candidate.source,
      sourceEventId: boundedIdentifier(candidate.sourceEventId),
      trust: candidate.trust,
    },
  };
  let data: Record<string, unknown>;
  switch (candidate.kind) {
    case "status": {
      const state = safeState(candidate.data.state);
      classes.add("unbounded_output");
      data = { state, summary: statusSummary(state) };
      break;
    }
    case "narrative": {
      classes.add("private_prompt");
      classes.add("unbounded_output");
      data = { summary: workerSummary(candidate.data.summaryCode) };
      break;
    }
    case "action": {
      classes.add("unbounded_output");
      data = {
        action: safeAction(candidate.data.action),
        result: safeActionResult(candidate.data.result),
        ...(isFingerprint(candidate.data.fingerprint) ? { fingerprint: candidate.data.fingerprint } : {}),
      };
      break;
    }
    case "artifact": {
      classes.add("unbounded_output");
      data = {
        label: "runner evidence",
        ref: safeArtifactRef(candidate.data.ref),
        summary: "Runner-authored evidence is available.",
      };
      break;
    }
    case "blocker": {
      classes.add("private_prompt");
      data = { summary: "Worker requires operator input." };
      break;
    }
    case "completion": {
      classes.add("unbounded_output");
      const status = safeCompletionStatus(candidate.data.status);
      data = {
        status,
        summary: `Runner observed worker completion with status ${status}.`,
        evidenceRefs: Array.isArray(candidate.data.evidenceRefs)
          ? candidate.data.evidenceRefs.filter(isArtifactRef).slice(0, 100)
          : [],
      };
      break;
    }
  }
  const classification = redactionClassification(classes);
  return WorkerTranscriptEntrySchema.parse({
    ...base,
    kind: candidate.kind,
    data,
    redaction: { classification, classes: [...classes].sort() },
  });
}

function workerSummary(value: unknown): string {
  const summaries: Record<string, string> = {
    reported_succeeded: "Worker reported successful progress.",
    reported_failed: "Worker reported a failed attempt.",
    reported_blocked: "Worker reported a blocked attempt.",
    reported_cancelled: "Worker reported a cancelled attempt.",
  };
  return typeof value === "string" ? (summaries[value] ?? PRIVATE_UPDATE) : PRIVATE_UPDATE;
}

function classifyDiscarded(value: unknown, classes: Set<WorkerTranscriptRedactionClass>, depth = 0): void {
  if (depth > 4) {
    classes.add("unbounded_output");
    return;
  }
  if (typeof value === "string") {
    if (/\bauthorization\s*:\s*(?:bearer|basic)\b|\bbearer\s+[A-Za-z0-9._~+/-]{8,}/iu.test(value)) {
      classes.add("authorization");
    }
    if (/\b(?:sk-|ghp_|github_pat_|xox[baprs]-)[_A-Za-z0-9-]{8,}/u.test(value)) classes.add("token");
    if (/\b(?:api[_ -]?key|token|password|passwd|secret|credential)\s*[:=]/iu.test(value)) {
      classes.add("credential");
    }
    if (/<think>|chain[ -]of[ -]thought|hidden reasoning|internal reasoning/iu.test(value)) {
      classes.add("chain_of_thought");
    }
    if (/private prompt/iu.test(value)) classes.add("private_prompt");
    if (/raw[_ -]?audio|audio\/pcm|audio\/wav/iu.test(value)) classes.add("raw_audio");
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 100)) classifyDiscarded(item, classes, depth + 1);
    if (value.length > 100) classes.add("unbounded_output");
    return;
  }
  if (!isRecord(value)) return;
  const entries = Object.entries(value);
  for (const [key, item] of entries.slice(0, 100)) {
    const normalized = key.toLowerCase().replaceAll(/[^a-z]/gu, "");
    if (normalized === "authorization") classes.add("authorization");
    if (normalized.includes("token")) classes.add("token");
    if (/apikey|password|passwd|secret|credential/u.test(normalized)) classes.add("credential");
    if (/chainofthought|reasoning/u.test(normalized)) classes.add("chain_of_thought");
    if (/prompt|modeltext/u.test(normalized)) classes.add("private_prompt");
    if (/rawaudio|audiobytes|pcm/u.test(normalized)) classes.add("raw_audio");
    if (/output|stdout|stderr/u.test(normalized)) classes.add("unbounded_output");
    classifyDiscarded(item, classes, depth + 1);
  }
  if (entries.length > 100) classes.add("unbounded_output");
}

function redactionClassification(
  classes: ReadonlySet<WorkerTranscriptRedactionClass>,
): "none" | "secrets_removed" | "private_content_removed" | "metadata_only" {
  if (classes.has("chain_of_thought") || classes.has("private_prompt") || classes.has("raw_audio")) {
    return "private_content_removed";
  }
  if (classes.has("authorization") || classes.has("token") || classes.has("credential")) {
    return "secrets_removed";
  }
  return classes.has("unbounded_output") ? "metadata_only" : "none";
}

function safeState(value: unknown): Extract<WorkerTranscriptEntry, { kind: "status" }>["data"]["state"] {
  const states = new Set([
    "unknown",
    "working",
    "idle",
    "waiting_dependency",
    "waiting_user",
    "blocked",
    "failed",
    "completed",
    "offline",
  ]);
  return typeof value === "string" && states.has(value)
    ? (value as Extract<WorkerTranscriptEntry, { kind: "status" }>["data"]["state"])
    : "unknown";
}

function statusSummary(state: string): string {
  const summaries: Record<string, string> = {
    unknown: "Worker status is unavailable.",
    working: "Worker is active.",
    idle: "Worker is idle.",
    waiting_dependency: "Worker is waiting on a dependency.",
    waiting_user: "Worker requires operator input.",
    blocked: "Worker is blocked.",
    failed: "Worker failed.",
    completed: "Worker completed.",
    offline: "Worker is offline.",
  };
  return summaries[state] ?? summaries.unknown ?? "Worker status is unavailable.";
}

function safeAction(value: unknown): string {
  const actions: Record<string, string> = {
    command: "provider command",
    file_change: "file change",
    plan: "plan update",
    diff: "diff update",
    verification: "verification command",
    session: "provider session",
  };
  return typeof value === "string" ? (actions[value] ?? "worker action") : "worker action";
}

function safeActionResult(value: unknown): "started" | "succeeded" | "failed" {
  return value === "started" || value === "succeeded" ? value : "failed";
}

function safeCompletionStatus(value: unknown): "succeeded" | "failed" | "blocked" | "cancelled" {
  return value === "succeeded" || value === "blocked" || value === "cancelled" ? value : "failed";
}

function safeArtifactRef(value: unknown): string {
  if (!isArtifactRef(value)) throw new Error("worker_transcript_artifact_ref_invalid");
  return value;
}

function isArtifactRef(value: unknown): value is string {
  return typeof value === "string" && /^artifact:\/\/[A-Za-z0-9._~:/-]{1,1000}$/u.test(value);
}

function isFingerprint(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function boundedIdentifier(value: string): string {
  const bounded = value.replace(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 256);
  if (!bounded) throw new Error("worker_transcript_source_event_id_invalid");
  return bounded;
}

function keyId(key: WorkerTranscriptKey): string {
  return createHash("sha256")
    .update(JSON.stringify([key.missionId, key.taskId, key.workerRunId]))
    .digest("hex");
}

function taskKey(key: WorkerTranscriptKey): string {
  return JSON.stringify([key.missionId, key.taskId]);
}

function generationFor(key: WorkerTranscriptKey): string {
  return createHash("sha256")
    .update(`worker-transcript-v1\0${keyId(key)}`)
    .digest("hex");
}

function cursorFor(generation: string, sequence: number): string {
  return Buffer.from(JSON.stringify({ g: generation, s: sequence }), "utf8").toString("base64url");
}

function parseCursor(cursor: string): CursorPayload | undefined {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!isRecord(value) || Object.keys(value).sort().join(",") !== "g,s") return undefined;
    if (typeof value.g !== "string" || !Number.isInteger(value.s) || Number(value.s) < 0) return undefined;
    return { g: value.g, s: Number(value.s) };
  } catch {
    return undefined;
  }
}

function snapshotFor(run: RunProjection): WorkerTranscriptSnapshot {
  return WorkerTranscriptSnapshotSchema.parse({
    schemaVersion: WORKER_TRANSCRIPT_SCHEMA_VERSION,
    outcome: "snapshot",
    key: run.key,
    generation: run.generation,
    retainedFromSequence: run.entries[0]?.sequence ?? 1,
    nextCursor: cursorFor(run.generation, run.entries.at(-1)?.sequence ?? 0),
    entries: run.entries,
  });
}

function tailLine(run: RunProjection, entry: WorkerTranscriptEntry): WorkerTranscriptTailLine {
  return WorkerTranscriptTailLineSchema.parse({
    schemaVersion: WORKER_TRANSCRIPT_SCHEMA_VERSION,
    type: "worker_transcript.entry",
    entry,
    cursor: cursorFor(run.generation, entry.sequence),
  });
}

async function persist(run: RunProjection): Promise<void> {
  const content = run.entries.map((entry) => JSON.stringify(entry)).join("\n");
  await replacePrivateFileAtomically(run.path, content ? `${content}\n` : "");
}

function validateReplay(entries: readonly WorkerTranscriptEntry[]): void {
  const first = entries[0];
  if (!first) throw new Error("worker_transcript_replay_empty");
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as WorkerTranscriptEntry;
    if (
      entry.missionId !== first.missionId ||
      entry.taskId !== first.taskId ||
      entry.workerRunId !== first.workerRunId ||
      (index > 0 && entry.sequence !== (entries[index - 1] as WorkerTranscriptEntry).sequence + 1)
    )
      throw new Error("worker_transcript_replay_invalid");
  }
}

function compareRuns(left: RunProjection | undefined, right: RunProjection): number {
  if (!left) return -1;
  const leftTime = left.entries[0]?.occurredAt ?? "";
  const rightTime = right.entries[0]?.occurredAt ?? "";
  return leftTime.localeCompare(rightTime) || left.key.workerRunId.localeCompare(right.key.workerRunId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  public push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value });
    else this.values.push(value);
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined });
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ done: false as const, value });
        if (this.closed) return Promise.resolve({ done: true as const, value: undefined });
        return new Promise<IteratorResult<T>>((resolvePromise) => this.waiters.push(resolvePromise));
      },
    };
  }
}
