import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { open, readdir } from "node:fs/promises";
import { isAbsolute, relative, join } from "node:path";
import { promisify } from "node:util";
import { parseHerdrSeatTranscript, resolveHerdrSeatTranscriptPath } from "@clankie/agent-transcript";
import type { ObservedFleetSeat } from "./herdr-census.ts";

export interface SeatTelemetry {
  readonly model?: string;
  readonly effort?: string;
  readonly contextPercent?: number;
  /** Explicit commit/report/finding evidence only; native activity is not progress. */
  readonly lastProgressAt?: string;
  /** Commit time at the observed cwd's HEAD; not proof the worker authored it. */
  readonly lastCommitAt?: string;
  readonly lastReportAt?: string;
  readonly reportFailedAt?: string;
  readonly reportFailures?: number;
  readonly reportFailureIds?: readonly string[];
}

const MAX_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const execFileAsync = promisify(execFile);
/** A known account, exact session filename, bounded directory discovery only. */
async function accountCodexPath(home: string, sessionId: string): Promise<string | undefined> {
  const root = join(home, "sessions");
  const millis = Number.parseInt(sessionId.replaceAll("-", "").slice(0, 12), 16);
  const date = new Date(millis);
  if (Number.isFinite(date.getTime())) {
    const directory = join(
      root,
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
    );
    try {
      const names = await readdir(directory);
      const matches = names.filter((name) => name.endsWith(`${sessionId}.jsonl`));
      if (matches.length === 1) return join(directory, matches[0]!);
    } catch {
      /* A legacy UUID may not encode the rollout date. */
    }
  }
  const pending = [{ path: root, depth: 0 }];
  let directories = 0;
  let entries = 0;
  const matches: string[] = [];
  while (pending.length > 0 && directories < 512 && entries < 10_000) {
    const current = pending.shift()!;
    directories++;
    let children;
    try {
      children = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    entries += children.length;
    if (entries > 10_000) return undefined;
    for (const child of children) {
      if (child.isFile() && child.name.endsWith(`${sessionId}.jsonl`))
        matches.push(join(current.path, child.name));
      else if (child.isDirectory() && current.depth < 3)
        pending.push({ path: join(current.path, child.name), depth: current.depth + 1 });
    }
  }
  return pending.length === 0 && matches.length === 1 ? matches[0] : undefined;
}
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
const timestamp = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
const rows = (raw: string) =>
  raw.split("\n").flatMap((line) => {
    try {
      return [object(JSON.parse(line))];
    } catch {
      return [];
    }
  });
const reportName = (name: string) => /(?:^|[._:])message_clankie$/u.test(name);
const failureDetail = (detail: string | undefined) => {
  if (detail === undefined) return false;
  try {
    const parsed = object(JSON.parse(detail));
    if (parsed.isError === true || parsed.is_error === true || parsed.status === "failed") return true;
  } catch {
    /* Native transport errors are often plain text rather than JSON. */
  }
  return /^(?:Error:|MCP error\b|Error executing tool\b|Tool call failed\b|Failed to call\b)/iu.test(
    detail.trim(),
  );
};

/** A bounded native snapshot, not a prose classifier or accumulated usage report. */
export function parseSeatTelemetry(
  harness: "codex" | "claude",
  raw: string,
  sessionId?: string,
): SeatTelemetry {
  let model: string | undefined;
  let effort: string | undefined;
  let window: number | undefined;
  let occupancy: number | undefined;
  const records = rows(raw).filter(
    (entry) =>
      harness !== "claude" ||
      (entry.isSidechain !== true &&
        (sessionId === undefined || entry.sessionId === undefined || entry.sessionId === sessionId)),
  );
  for (const entry of records) {
    const payload = object(entry.payload);
    if (harness === "codex") {
      if (sessionId !== undefined && typeof payload.thread_id === "string" && payload.thread_id !== sessionId)
        continue;
      if (entry.type === "turn_context") {
        const settings = object(object(payload.collaboration_mode).settings);
        model = text(payload.model, 256) ?? text(settings.model, 256) ?? model;
        effort =
          text(payload.effort, 64) ??
          text(payload.reasoning_effort, 64) ??
          text(settings.reasoning_effort, 64) ??
          effort;
      }
      if (
        entry.type === "compacted" ||
        (entry.type === "event_msg" && ["context_compacted", "compaction"].includes(String(payload.type)))
      )
        occupancy = undefined;
      if (entry.type === "event_msg" && payload.type === "task_started") {
        window = count(payload.model_context_window) ?? window;
      }
      if (entry.type === "event_msg" && payload.type === "token_count") {
        const info = object(payload.info);
        window = count(info.model_context_window) ?? count(payload.model_context_window) ?? window;
        // Last response's input is a current model-context snapshot. The total
        // usage counter and token_usage_record are lifetime/turn usage, not context.
        occupancy = count(object(info.last_token_usage).input_tokens);
      }
    } else if (entry.type === "assistant") {
      model = text(object(entry.message).model, 256) ?? model;
      // Claude's retained message usage has no native context-window contract;
      // report model only rather than guessing a capacity from its spelling.
    }
  }
  const validRaw = records.map((entry) => JSON.stringify(entry)).join("\n");
  const reportCalls = new Set<string>();
  let lastReportAt: string | undefined;
  let reportFailedAt: string | undefined;
  const failed = new Set<string>();
  for (const entry of parseHerdrSeatTranscript(harness, validRaw)) {
    if (entry.type !== "tool") continue;
    if (reportName(entry.name)) reportCalls.add(entry.toolCallId);
    if (!reportCalls.has(entry.toolCallId) || entry.phase === "started") continue;
    const at = timestamp(entry.occurredAt);
    if (at === undefined) continue;
    if (lastReportAt === undefined || at > lastReportAt) lastReportAt = at;
    if (entry.phase === "failed" || failureDetail(entry.detail)) {
      failed.add(entry.toolCallId);
      if (reportFailedAt === undefined || at > reportFailedAt) reportFailedAt = at;
    }
  }
  return {
    ...(model === undefined ? {} : { model }),
    ...(effort === undefined ? {} : { effort }),
    ...(window === undefined || window === 0 || occupancy === undefined
      ? {}
      : { contextPercent: Math.min(100, (100 * occupancy) / window) }),
    ...(lastReportAt === undefined ? {} : { lastReportAt }),
    ...(reportFailedAt === undefined
      ? {}
      : { reportFailedAt, reportFailures: failed.size, reportFailureIds: [...failed] }),
  };
}

/** Only an already observed exact local session; never discover or control a worker. */
async function readNativeSeatTelemetry(observed: ObservedFleetSeat): Promise<SeatTelemetry | undefined> {
  if (
    observed.fleet !== undefined ||
    !["codex", "claude"].includes(observed.harness) ||
    observed.session === undefined
  )
    return undefined;
  const harness = observed.harness as "codex" | "claude";
  const session = observed.session;
  if (
    session.source !== `herdr:${harness}` ||
    (session.kind === "id" &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(session.value))
  )
    return undefined;
  try {
    const path =
      harness === "codex" && session.kind === "id" && observed.account !== undefined
        ? await accountCodexPath(observed.account.home, session.value)
        : resolveHerdrSeatTranscriptPath(harness, session);
    if (path === undefined || !isAbsolute(path)) return undefined;
    if (observed.account !== undefined && harness === "codex") {
      const within = relative(observed.account.home, path);
      if (within.startsWith("../") || isAbsolute(within)) return undefined;
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await handle.stat();
      if (!before.isFile()) return undefined;
      const head = Buffer.alloc(Math.min(before.size, MAX_HEADER_BYTES));
      const first = await handle.read(head, 0, head.length, 0);
      const header = rows(head.subarray(0, first.bytesRead).toString());
      const nativeId =
        harness === "codex"
          ? header.find((entry) => entry.type === "session_meta")?.payload
          : header.find((entry) => typeof entry.sessionId === "string");
      const id = harness === "codex" ? text(object(nativeId).id, 256) : text(object(nativeId).sessionId, 256);
      if (id === undefined || (session.kind === "id" && id !== session.value)) return undefined;
      const from = Math.max(0, before.size - MAX_TAIL_BYTES);
      const tail = Buffer.alloc(before.size - from);
      const last = await handle.read(tail, 0, tail.length, from);
      const after = await handle.stat();
      if (before.dev !== after.dev || before.ino !== after.ino || after.size < before.size) return undefined;
      let raw = tail.subarray(0, last.bytesRead).toString();
      if (from > 0) raw = raw.slice(raw.indexOf("\n") + 1);
      return parseSeatTelemetry(harness, raw, id);
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

async function readCommitAt(observed: ObservedFleetSeat): Promise<string | undefined> {
  if (
    observed.fleet !== undefined ||
    observed.workingDirectory === undefined ||
    !isAbsolute(observed.workingDirectory)
  )
    return undefined;
  try {
    // Inherited Git overrides must not redirect evidence away from the exact cwd.
    const { GIT_DIR: _dir, GIT_WORK_TREE: _work, GIT_INDEX_FILE: _index, ...environment } = process.env;
    const result = await execFileAsync(
      "git",
      ["-C", observed.workingDirectory, "log", "-1", "--format=%cI"],
      { timeout: 1500, maxBuffer: 1024, env: { ...environment, GIT_OPTIONAL_LOCKS: "0" } },
    );
    return timestamp(result.stdout.trim());
  } catch {
    return undefined;
  }
}

/** Git progress evidence remains available when the native telemetry seam is unknown. */
export async function readSeatTelemetry(observed: ObservedFleetSeat): Promise<SeatTelemetry | undefined> {
  const [native, lastCommitAt] = await Promise.all([
    readNativeSeatTelemetry(observed),
    readCommitAt(observed),
  ]);
  if (native === undefined && lastCommitAt === undefined) return undefined;
  return { ...native, ...(lastCommitAt === undefined ? {} : { lastCommitAt }) };
}
