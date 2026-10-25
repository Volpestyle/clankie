import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { open, readdir, lstat, realpath, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, join, resolve } from "node:path";
import { promisify } from "node:util";
import { herdrSeatTranscriptEntries } from "@clankie/agent-transcript";
import type {
  OperatorAgentActivity,
  OperatorAgentActivityKind,
  OperatorAgentStance,
} from "@clankie/protocol";
import { z } from "zod";
import type { ObservedFleetSeat } from "./herdr-census.ts";

export interface SeatTelemetry {
  readonly model?: string;
  readonly effort?: string;
  readonly contextPercent?: number;
  /** Explicit commit/report/finding evidence only; native activity is not progress. */
  readonly lastProgressAt?: string;
  /** Advanced descendant commit on the seat's admitted exclusive worktree/branch. */
  readonly lastCommitAt?: string;
  readonly lastReportAt?: string;
  readonly reportFailedAt?: string;
  readonly reportFailures?: number;
  readonly reportFailureIds?: readonly string[];
}

const MAX_TAIL_BYTES = 2 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const execFileAsync = promisify(execFile);
const CACHE_LIMIT = 256;
/** Decoded native tails retained for append continuation; each holds at most MAX_TAIL_BYTES of lines. */
const TAIL_LIMIT = 16;
/** A bounded observation, not evidence that a forgotten tool is still running. */
const ACTIVITY_MAX_AGE_MS = 5 * 60_000;
const TOOL_KINDS = new Map<string, OperatorAgentActivityKind>([
  ...["Read", "Grep", "Glob", "read", "read_file", "search_query", "web_search", "WebSearch", "WebFetch"].map(
    (name) => [name, "reading"] as const,
  ),
  ...["Edit", "MultiEdit", "Write", "edit", "write", "apply_patch"].map((name) => [name, "editing"] as const),
  ...["run_tests", "typecheck", "build"].map((name) => [name, "testing"] as const),
  ...["update_plan", "EnterPlanMode", "ExitPlanMode"].map((name) => [name, "planning"] as const),
  ...["AskUserQuestion", "request_user_input", "request_user_input_async"].map(
    (name) => [name, "waiting"] as const,
  ),
]);

function nativeActivity(
  harness: "codex" | "claude",
  records: Record<string, unknown>[],
): OperatorAgentActivity | undefined {
  // A native turn boundary cancels any unmatched call from the preceding turn.
  const boundary = records.findLastIndex((entry) =>
    harness === "codex"
      ? entry.type === "event_msg" &&
        ["task_started", "task_complete", "task_completed", "turn_aborted", "turn_interrupted"].includes(
          String(object(entry.payload).type),
        )
      : entry.type === "assistant" && object(entry.message).stop_reason === "end_turn",
  );
  const turn = records.slice(boundary + 1);
  // Codex code mode wraps every call in `exec`; keep its raw source, never the redacted detail.
  const sources = new Map<string, string>();
  if (harness === "codex")
    for (const entry of turn) {
      const payload = object(entry.payload);
      if (entry.type === "response_item" && payload.type === "custom_tool_call" && codeMode(payload.name))
        if (typeof payload.call_id === "string" && typeof payload.input === "string")
          sources.set(payload.call_id, payload.input);
    }
  const active = new Map<string, Extract<OperatorAgentActivity, { source: "native_tool" }> | undefined>();
  for (const entry of herdrSeatTranscriptEntries(harness, turn)) {
    if (entry.type === "message" && entry.role === "operator" && !entry.internal) active.clear();
    if (entry.type !== "tool") continue;
    if (entry.phase !== "started") {
      active.delete(entry.toolCallId);
      continue;
    }
    // Only native qualified namespaces are accepted, never a suffix guessed from MCP names.
    const source = sources.get(entry.toolCallId);
    const name =
      source === undefined
        ? entry.name.replace(/^(?:functions|tools)\./u, "")
        : (codeModeCall(source) ?? entry.name);
    const kind = TOOL_KINDS.get(name);
    const at = timestamp(entry.occurredAt);
    active.set(
      entry.toolCallId,
      kind === undefined || at === undefined
        ? undefined
        : {
            source: "native_tool",
            kind,
            toolName: name,
            startedAt: at,
          },
    );
  }
  const calls = [...active.values()];
  // Parallel unknown or conflicting calls do not establish a single work kind.
  const first = calls[0];
  return first && calls.every((call) => call?.kind === first.kind) ? first : undefined;
}
const codeMode = (name: unknown) => name === "exec" || name === "functions.exec";
/**
 * The one tool a code-mode source calls, when the whole source is a single
 * awaited call with a JSON literal argument. Source is never evaluated; any
 * other statement, expression or truncated argument leaves the call unknown.
 */
function codeModeCall(source: string): string | undefined {
  const snippet = source.replace(/^\s*\/\/ @exec:[^\n]*\n/u, "").trim();
  if (snippet.length > 65_536) return undefined;
  const call =
    /^(?:text\(\s*(?:await\s+)?tools\.(\w+)\s*\(\s*("[\s\S]*"|\{[\s\S]*\})\s*\)\s*\)|(?:await\s+)?tools\.(\w+)\s*\(\s*("[\s\S]*"|\{[\s\S]*\})\s*\))\s*;?$/u.exec(
      snippet,
    );
  if (!call) return undefined;
  try {
    // A JSON literal is one JavaScript literal, so the call cannot extend past it.
    JSON.parse(call[2] ?? call[4]!);
    return call[1] ?? call[3];
  } catch {
    return undefined;
  }
}
const NativeId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const preparedPaths = new Map<string, Promise<string | undefined>>();
const resolvedPaths = new Map<string, string | undefined>();
function boundedSet<T>(map: Map<string, T>, key: string, value: T, limit = CACHE_LIMIT): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value!);
}
// Census may know the native session before it knows a profile. Resolve the
// canonical primary home without consulting credentials or account settings.
const codexHome = (seat: ObservedFleetSeat) =>
  seat.account?.home ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
const sessionKey = (seat: ObservedFleetSeat) =>
  JSON.stringify([
    seat.fleet,
    seat.harness,
    seat.harness === "codex" ? codexHome(seat) : seat.account?.home,
    seat.session,
  ]);

/** Prepare one exact native address at admission/discovery, never on roster refresh. */
export async function prepareSeatTelemetry(
  observed: ObservedFleetSeat,
  options: { transcriptPath?: string | undefined } = {},
): Promise<void> {
  if (observed.fleet !== undefined || observed.session === undefined) return;
  const key = sessionKey(observed);
  if (options.transcriptPath !== undefined) {
    if (isAbsolute(options.transcriptPath)) {
      boundedSet(preparedPaths, key, Promise.resolve(options.transcriptPath));
      boundedSet(resolvedPaths, key, options.transcriptPath);
    }
    return;
  }
  if (preparedPaths.has(key)) return;
  const preparing = (async () => {
    const session = observed.session!;
    if (session.source !== `herdr:${observed.harness}`) return undefined;
    if (session.kind === "path") return isAbsolute(session.value) ? session.value : undefined;
    if (observed.harness !== "codex" || !NativeId.test(session.value)) return undefined;
    const home = codexHome(observed);
    if (!isAbsolute(home)) return undefined;
    // Only UUIDv7 supplies a date. Other native IDs require an explicit path.
    if (session.value[14] !== "7") return undefined;
    const date = new Date(Number.parseInt(session.value.replaceAll("-", "").slice(0, 12), 16));
    if (!Number.isFinite(date.getTime())) return undefined;
    const directory = join(
      home,
      "sessions",
      String(date.getUTCFullYear()),
      String(date.getUTCMonth() + 1).padStart(2, "0"),
      String(date.getUTCDate()).padStart(2, "0"),
    );
    try {
      const names = await readdir(directory);
      if (names.length > 2000) return undefined;
      const matches = names.filter((name) => name.endsWith(`${session.value}.jsonl`));
      return matches.length === 1 ? join(directory, matches[0]!) : undefined;
    } catch {
      return undefined;
    }
  })();
  // Missing addresses stay unknown until the host supplies a prepared path;
  // they never trigger a repeated account-directory search during refresh.
  boundedSet(preparedPaths, key, preparing);
  boundedSet(resolvedPaths, key, await preparing);
}

export const SeatCommitBaselineSchema = z
  .object({
    worktreeRoot: z.string().min(1).max(4096),
    gitDir: z.string().min(1).max(4096),
    commonDir: z.string().min(1).max(4096),
    branchRef: z.string().startsWith("refs/heads/").max(1024),
    head: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu),
    capturedAt: z.string().datetime(),
  })
  .strict();
export type SeatCommitBaseline = z.infer<typeof SeatCommitBaselineSchema>;
export type SeatCommitClaim = Pick<SeatCommitBaseline, "worktreeRoot" | "gitDir" | "commonDir" | "branchRef">;
const gitEnvironment = () => {
  const {
    GIT_DIR: _dir,
    GIT_WORK_TREE: _work,
    GIT_INDEX_FILE: _index,
    GIT_COMMON_DIR: _common,
    GIT_OBJECT_DIRECTORY: _objects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: _alternates,
    ...environment
  } = process.env;
  return { ...environment, GIT_OPTIONAL_LOCKS: "0" };
};
const git = (cwd: string, args: string[]) =>
  execFileAsync("git", ["-C", cwd, ...args], { timeout: 1500, maxBuffer: 16_384, env: gitEnvironment() });

/** Capture before native work begins; a primary checkout cannot own this signal. */
export async function readSeatCommitBaseline(cwd: string): Promise<SeatCommitBaseline | undefined> {
  if (!isAbsolute(cwd)) return undefined;
  try {
    const paths = (
      await git(cwd, ["rev-parse", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"])
    ).stdout
      .trim()
      .split("\n");
    if (paths.length !== 3) return undefined;
    const [worktreeRoot, gitDir, commonDir] = await Promise.all([
      realpath(paths[0]!),
      realpath(paths[1]!),
      realpath(resolve(cwd, paths[2]!)),
    ]);
    if (gitDir === commonDir || !(await lstat(join(worktreeRoot, ".git"))).isFile()) return undefined;
    const [branch, commit] = await Promise.all([
      git(worktreeRoot, ["symbolic-ref", "--quiet", "HEAD"]),
      git(worktreeRoot, ["rev-parse", "--verify", "HEAD"]),
    ]);
    const baseline = SeatCommitBaselineSchema.parse({
      worktreeRoot,
      gitDir,
      commonDir,
      branchRef: branch.stdout.trim(),
      head: commit.stdout.trim(),
      capturedAt: new Date().toISOString(),
    });
    // Renew filesystem and branch identity after the capture's independent reads.
    if ((await currentHead(baseline, cwd)) !== baseline.head) return undefined;
    return baseline;
  } catch {
    return undefined;
  }
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
const row = (line: string) => {
  try {
    return object(JSON.parse(line));
  } catch {
    return undefined;
  }
};
const rows = (raw: string) =>
  raw.split("\n").flatMap((line) => {
    const value = row(line);
    return value === undefined ? [] : [value];
  });
const reportName = (name: string) => /(?:^|[._:])message_clankie$/u.test(name);
const failureDetail = (detail: string | undefined) => {
  if (detail === undefined) return false;
  try {
    const parsed = object(JSON.parse(detail));
    if (
      parsed.isError === true ||
      parsed.is_error === true ||
      parsed.status === "failed" ||
      parsed.received === false
    )
      return true;
  } catch {
    /* Native transport errors are often plain text rather than JSON. */
  }
  return /^(?:Error:|MCP error\b|Error executing tool\b|Tool call failed\b|Failed to call\b)/iu.test(
    detail.trim(),
  );
};

/** A bounded native snapshot, not a prose classifier or accumulated usage report. */
function parseSeatTelemetry(
  harness: "codex" | "claude",
  tail: readonly Record<string, unknown>[],
  sessionId?: string,
): SeatTelemetry {
  let model: string | undefined;
  let effort: string | undefined;
  let window: number | undefined;
  let occupancy: number | undefined;
  const reportCalls = new Set<string>();
  let lastReportAt: string | undefined;
  let reportFailedAt: string | undefined;
  const failed = new Set<string>();
  const settle = (id: string, occurredAt: unknown, failure: boolean) => {
    const at = timestamp(occurredAt);
    if (at === undefined) return;
    if (failure) {
      failed.add(id);
      if (reportFailedAt === undefined || at > reportFailedAt) reportFailedAt = at;
    } else if (lastReportAt === undefined || at > lastReportAt) lastReportAt = at;
  };
  const records = tail.filter(
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
      // Code mode records MCP calls only as completed native items, never as response calls.
      const item =
        entry.type === "event_msg" && payload.type === "item_completed" ? object(payload.item) : {};
      if (
        item.type === "McpToolCall" &&
        typeof item.id === "string" &&
        typeof item.tool === "string" &&
        reportName(item.tool)
      ) {
        const result = object(item.result);
        const content = Array.isArray(result.content) ? result.content.map((part) => object(part).text) : [];
        settle(
          item.id,
          entry.timestamp,
          item.status === "failed" ||
            result.isError === true ||
            object(result.structuredContent).received === false ||
            failureDetail(content.filter((part) => typeof part === "string").join("\n") || undefined),
        );
      }
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
  for (const entry of herdrSeatTranscriptEntries(harness, records)) {
    if (entry.type !== "tool") continue;
    if (reportName(entry.name)) reportCalls.add(entry.toolCallId);
    if (!reportCalls.has(entry.toolCallId) || entry.phase === "started") continue;
    settle(entry.toolCallId, entry.occurredAt, entry.phase === "failed" || failureDetail(entry.detail));
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

type FileIdentity = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint };
const fileStamp = (value: FileIdentity) => `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}`;
type NativeSnapshot = {
  stamp: string;
  sessionId?: string;
  telemetry?: SeatTelemetry;
  activity?: OperatorAgentActivity;
};
const nativeSnapshots = new Map<string, NativeSnapshot>();
const nativeReads = new Map<string, Promise<NativeSnapshot | undefined>>();
const smallFiles = new Map<string, { stamp: string; value: string }>();

async function smallFile(path: string, maxBytes = 8192): Promise<string> {
  const metadata = await lstat(path, { bigint: true });
  if (!metadata.isFile() || metadata.size > BigInt(maxBytes))
    throw new Error("Telemetry metadata unavailable");
  const stamp = fileStamp(metadata);
  const cached = smallFiles.get(path);
  if (cached?.stamp === stamp) return cached.value;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (fileStamp(await handle.stat({ bigint: true })) !== stamp)
      throw new Error("Telemetry metadata changed");
    const bytes = Buffer.alloc(Number(metadata.size));
    const read = await handle.read(bytes, 0, bytes.length, 0);
    if (fileStamp(await handle.stat({ bigint: true })) !== stamp)
      throw new Error("Telemetry metadata changed");
    const value = bytes.subarray(0, read.bytesRead).toString();
    boundedSet(smallFiles, path, { stamp, value });
    return value;
  } finally {
    await handle.close();
  }
}

/**
 * Complete lines of one native file's bounded tail, decoded once. An append that
 * leaves every decoded byte unchanged decodes only its new bytes; anything else
 * reads the tail again.
 */
type NativeTail = {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: number;
  readonly head: Buffer;
  readonly sessionId: string | undefined;
  /** Where the decoded window starts: after the cut newline, or 0. */
  readonly region: number;
  /** Byte offset just past the last complete line decoded. */
  readonly end: number;
  /** SHA-256 of the bytes from `region` to `end`, malformed lines included. */
  readonly digest: Buffer;
  readonly records: readonly Record<string, unknown>[];
};
const nativeTails = new Map<string, NativeTail>();

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const bytes = Buffer.alloc(length);
  const read = await handle.read(bytes, 0, length, position);
  return bytes.subarray(0, read.bytesRead);
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest();

async function nativeSnapshot(
  path: string,
  harness: "codex" | "claude",
  stamp: string,
  key: string,
): Promise<NativeSnapshot | undefined> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || fileStamp(before) !== stamp || before.size > BigInt(Number.MAX_SAFE_INTEGER))
      return undefined;
    const size = Number(before.size);
    const from = Math.max(0, size - MAX_TAIL_BYTES);
    const head = await readAt(handle, 0, Math.min(size, MAX_HEADER_BYTES));
    const prior = nativeTails.get(key);
    const candidate =
      prior !== undefined &&
      prior.dev === before.dev &&
      prior.ino === before.ino &&
      size > prior.size &&
      prior.end > from &&
      head.subarray(0, prior.head.length).equals(prior.head)
        ? prior
        : undefined;
    // A cold read cuts its window after the first newline at or past `from`.
    const cut = (at: number, buffer: Buffer) => (from === 0 ? 0 : at + buffer.indexOf(0x0a, from - at) + 1);
    // Read from the earlier of `from` and the decoded window, so the current cut is observed too.
    let base = candidate === undefined ? from : Math.min(from, candidate.region);
    let bytes = await readAt(handle, base, size - base);
    let region = cut(base, bytes);
    // Reuse decoded lines only for the same cut, with every byte from it to their end unchanged.
    const reused =
      candidate !== undefined &&
      region === candidate.region &&
      bytes.length >= candidate.end - base &&
      digest(bytes.subarray(candidate.region - base, candidate.end - base)).equals(candidate.digest)
        ? candidate
        : undefined;
    if (reused === undefined && base !== from) {
      base = from;
      bytes = await readAt(handle, from, size - from);
      region = cut(base, bytes);
    }
    if (fileStamp(await handle.stat({ bigint: true })) !== stamp) return undefined;
    let sessionId = reused !== undefined && head.length === reused.head.length ? reused.sessionId : undefined;
    if (sessionId === undefined) {
      const header = rows(head.toString());
      const nativeId =
        harness === "codex"
          ? header.find((entry) => entry.type === "session_meta")?.payload
          : header.find((entry) => typeof entry.sessionId === "string");
      sessionId =
        harness === "codex" ? text(object(nativeId).id, 256) : text(object(nativeId).sessionId, 256);
    }
    if (sessionId === undefined) return undefined;
    let cursor = reused === undefined ? region - base : reused.end - base;
    const records = reused ? [...reused.records] : [];
    for (let newline = bytes.indexOf(0x0a, cursor); newline >= 0; newline = bytes.indexOf(0x0a, cursor)) {
      const record = row(bytes.toString("utf8", cursor, newline));
      if (record !== undefined) records.push(record);
      cursor = newline + 1;
    }
    const end = base + cursor;
    const tail = {
      dev: before.dev,
      ino: before.ino,
      size,
      head: Buffer.from(head),
      sessionId,
      region,
      end,
      digest: digest(bytes.subarray(region - base, cursor)),
      records,
    };
    if (nativeTails.get(key) === prior) boundedSet(nativeTails, key, tail, TAIL_LIMIT);
    // An unterminated final line counts as a whole read would count it, but is decoded again next time.
    const last = cursor < bytes.length ? row(bytes.toString("utf8", cursor)) : undefined;
    const current = last === undefined ? records : [...records, last];
    const parsed = parseSeatTelemetry(harness, current, sessionId);
    if (parsed.reportFailureIds) Object.freeze(parsed.reportFailureIds);
    const activity = nativeActivity(
      harness,
      current.filter((entry) =>
        harness === "claude"
          ? entry.isSidechain !== true && (entry.sessionId === undefined || entry.sessionId === sessionId)
          : object(entry.payload).thread_id === undefined || object(entry.payload).thread_id === sessionId,
      ),
    );
    return {
      stamp,
      sessionId,
      telemetry: Object.freeze(parsed),
      ...(activity === undefined ? {} : { activity: Object.freeze(activity) }),
    };
  } finally {
    await handle.close();
  }
}

/** Refresh reads metadata and cached snapshots, never account-directory discovery. */
async function readNativeSeatSnapshot(
  observed: ObservedFleetSeat,
  transcriptPath?: string,
): Promise<NativeSnapshot | undefined> {
  if (
    observed.fleet !== undefined ||
    !["codex", "claude"].includes(observed.harness) ||
    observed.session === undefined
  )
    return undefined;
  const harness = observed.harness as "codex" | "claude";
  const session = observed.session;
  if (session.source !== `herdr:${harness}` || (session.kind === "id" && !NativeId.test(session.value)))
    return undefined;
  try {
    const path =
      transcriptPath ?? (session.kind === "path" ? session.value : resolvedPaths.get(sessionKey(observed)));
    if (path === undefined || !isAbsolute(path)) return undefined;
    if (observed.account !== undefined && harness === "codex") {
      const within = relative(observed.account.home, path);
      if (within === ".." || within.startsWith("../") || isAbsolute(within)) return undefined;
    }
    const metadata = await lstat(path, { bigint: true });
    if (!metadata.isFile()) return undefined;
    const stamp = fileStamp(metadata);
    const key = `${harness}:${path}`;
    let snapshot = nativeSnapshots.get(key);
    if (snapshot?.stamp !== stamp) {
      const pendingKey = `${key}:${stamp}`;
      let reading = nativeReads.get(pendingKey);
      if (reading === undefined) {
        reading = nativeSnapshot(path, harness, stamp, key);
        nativeReads.set(pendingKey, reading);
      }
      try {
        snapshot = await reading;
      } finally {
        nativeReads.delete(pendingKey);
      }
      snapshot ??= { stamp };
      boundedSet(nativeSnapshots, key, snapshot);
    }
    if (!snapshot || (session.kind === "id" && snapshot.sessionId !== session.value)) return undefined;
    return snapshot;
  } catch {
    return undefined;
  }
}

/** Latest read only: unsupported/idle/offline seats carry no activity fact. */
export async function readSeatActivity(
  observed: ObservedFleetSeat,
  status: string,
  stance?: OperatorAgentStance,
): Promise<OperatorAgentActivity | undefined> {
  if (status !== "working" && status !== "blocked") return undefined;
  const activity = status === "working" ? (await readNativeSeatSnapshot(observed))?.activity : undefined;
  if (activity?.source === "native_tool") {
    const age = Date.now() - Date.parse(activity.startedAt);
    if (age >= 0 && age < ACTIVITY_MAX_AGE_MS) return activity;
  }
  if (stance?.activityKind !== undefined && Date.parse(stance.expiresAt) > Date.now())
    return {
      source: "stated",
      kind: stance.activityKind,
      statedAt: stance.statedAt,
      expiresAt: stance.expiresAt,
    };
  return undefined;
}

/** Fresh branch claims use small cached metadata, never Git processes or discovery. */
export async function readSeatCommitClaim(
  cwd: string,
  input: SeatCommitBaseline,
): Promise<SeatCommitClaim | undefined> {
  if (!isAbsolute(cwd)) return undefined;
  try {
    const baseline = SeatCommitBaselineSchema.parse(input);
    if (![baseline.worktreeRoot, baseline.gitDir, baseline.commonDir].every(isAbsolute)) return undefined;
    const within = relative(baseline.worktreeRoot, await realpath(cwd));
    if (
      within === ".." ||
      within.startsWith("../") ||
      isAbsolute(within) ||
      baseline.gitDir === baseline.commonDir
    )
      return undefined;
    const pointer = (await smallFile(join(baseline.worktreeRoot, ".git"))).trim();
    if (
      !pointer.startsWith("gitdir: ") ||
      (await realpath(resolve(baseline.worktreeRoot, pointer.slice(8)))) !== baseline.gitDir
    )
      return undefined;
    const common = (await smallFile(join(baseline.gitDir, "commondir"))).trim();
    if ((await realpath(resolve(baseline.gitDir, common))) !== baseline.commonDir) return undefined;
    const head = (await smallFile(join(baseline.gitDir, "HEAD"))).trim();
    if (!head.startsWith("ref: ")) return undefined;
    const branchRef = head.slice(5);
    if (
      !branchRef.startsWith("refs/heads/") ||
      branchRef.length > 1024 ||
      /[\s~^:?*[\\]/u.test(branchRef) ||
      branchRef.includes("@{") ||
      branchRef
        .split("/")
        .some((part) => !part || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))
    )
      return undefined;
    return {
      worktreeRoot: baseline.worktreeRoot,
      gitDir: baseline.gitDir,
      commonDir: baseline.commonDir,
      branchRef,
    };
  } catch {
    return undefined;
  }
}

/** Commit attribution requires the same branch captured at admission. */
async function currentHead(baseline: SeatCommitBaseline, cwd: string): Promise<string | undefined> {
  const claim = await readSeatCommitClaim(cwd, baseline);
  if (claim?.branchRef !== baseline.branchRef) return undefined;
  const refPath = resolve(baseline.commonDir, baseline.branchRef);
  if (
    !refPath.startsWith(`${baseline.commonDir}/refs/heads/`) ||
    relative(baseline.commonDir, refPath).startsWith("../")
  )
    return undefined;
  let head: string;
  try {
    head = (await smallFile(refPath, 256)).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const packed = await smallFile(join(baseline.commonDir, "packed-refs"), 2 * 1024 * 1024);
    head =
      packed
        .split("\n")
        .find((line) => line.endsWith(` ${baseline.branchRef}`))
        ?.split(" ")[0] ?? "";
  }
  return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/iu.test(head) ? head : undefined;
}
const commitSnapshots = new Map<string, { head: string; at: string | undefined }>();
const commitReads = new Map<string, Promise<string | undefined>>();
async function readCommitAt(
  observed: ObservedFleetSeat,
  input: SeatCommitBaseline | undefined,
): Promise<string | undefined> {
  if (
    observed.fleet !== undefined ||
    observed.workingDirectory === undefined ||
    !isAbsolute(observed.workingDirectory) ||
    input === undefined
  )
    return undefined;
  try {
    const baseline = SeatCommitBaselineSchema.parse(input);
    const head = await currentHead(baseline, observed.workingDirectory);
    if (head === undefined || head === baseline.head) return undefined;
    const key = JSON.stringify([baseline.gitDir, baseline.branchRef, baseline.head]);
    const cached = commitSnapshots.get(key);
    if (cached?.head === head) return cached.at;
    const pendingKey = `${key}:${head}`;
    let reading = commitReads.get(pendingKey);
    if (!reading) {
      reading = (async () => {
        await git(baseline.worktreeRoot, ["merge-base", "--is-ancestor", baseline.head, head]);
        const result = await git(baseline.worktreeRoot, [
          "log",
          "-1",
          "--no-show-signature",
          "--format=%cI",
          head,
        ]);
        return timestamp(result.stdout.trim());
      })().catch(() => undefined);
      commitReads.set(pendingKey, reading);
    }
    let at;
    try {
      at = await reading;
    } finally {
      commitReads.delete(pendingKey);
    }
    if ((await currentHead(baseline, observed.workingDirectory)) !== head) return undefined;
    boundedSet(commitSnapshots, key, { head, at });
    return at;
  } catch {
    return undefined;
  }
}

/** Git progress evidence remains available when the native telemetry seam is unknown. */
export async function readSeatTelemetry(
  observed: ObservedFleetSeat,
  options: {
    commitBaseline?: SeatCommitBaseline | undefined;
    transcriptPath?: string | undefined;
  } = {},
): Promise<SeatTelemetry | undefined> {
  const [native, lastCommitAt] = await Promise.all([
    readNativeSeatSnapshot(observed, options.transcriptPath).then((snapshot) => snapshot?.telemetry),
    readCommitAt(observed, options.commitBaseline),
  ]);
  if (native === undefined && lastCommitAt === undefined) return undefined;
  return lastCommitAt === undefined ? native : Object.freeze({ ...native, lastCommitAt });
}
