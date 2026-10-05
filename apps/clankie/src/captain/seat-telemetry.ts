import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { open, readdir, lstat, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, join, resolve } from "node:path";
import { promisify } from "node:util";
import { parseHerdrSeatTranscript } from "@clankie/agent-transcript";
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
const NativeId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const preparedPaths = new Map<string, Promise<string | undefined>>();
const resolvedPaths = new Map<string, string | undefined>();
function boundedSet<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > CACHE_LIMIT) map.delete(map.keys().next().value!);
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

type FileIdentity = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint };
const fileStamp = (value: FileIdentity) => `${value.dev}:${value.ino}:${value.size}:${value.mtimeNs}`;
type NativeSnapshot = { stamp: string; sessionId?: string; telemetry?: SeatTelemetry };
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

async function nativeSnapshot(
  path: string,
  harness: "codex" | "claude",
  stamp: string,
): Promise<NativeSnapshot | undefined> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || fileStamp(before) !== stamp || before.size > BigInt(Number.MAX_SAFE_INTEGER))
      return undefined;
    const size = Number(before.size);
    const head = Buffer.alloc(Math.min(size, MAX_HEADER_BYTES));
    const first = await handle.read(head, 0, head.length, 0);
    const header = rows(head.subarray(0, first.bytesRead).toString());
    const nativeId =
      harness === "codex"
        ? header.find((entry) => entry.type === "session_meta")?.payload
        : header.find((entry) => typeof entry.sessionId === "string");
    const id = harness === "codex" ? text(object(nativeId).id, 256) : text(object(nativeId).sessionId, 256);
    if (id === undefined) return undefined;
    const from = Math.max(0, size - MAX_TAIL_BYTES);
    const tail = Buffer.alloc(size - from);
    const last = await handle.read(tail, 0, tail.length, from);
    if (fileStamp(await handle.stat({ bigint: true })) !== stamp) return undefined;
    let raw = tail.subarray(0, last.bytesRead).toString();
    if (from > 0) raw = raw.slice(raw.indexOf("\n") + 1);
    const parsed = parseSeatTelemetry(harness, raw, id);
    if (parsed.reportFailureIds) Object.freeze(parsed.reportFailureIds);
    return { stamp, sessionId: id, telemetry: Object.freeze(parsed) };
  } finally {
    await handle.close();
  }
}

/** Refresh reads metadata and cached snapshots, never account-directory discovery. */
async function readNativeSeatTelemetry(
  observed: ObservedFleetSeat,
  transcriptPath?: string,
): Promise<SeatTelemetry | undefined> {
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
        reading = nativeSnapshot(path, harness, stamp);
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
    return snapshot.telemetry;
  } catch {
    return undefined;
  }
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
    readNativeSeatTelemetry(observed, options.transcriptPath),
    readCommitAt(observed, options.commitBaseline),
  ]);
  if (native === undefined && lastCommitAt === undefined) return undefined;
  return lastCommitAt === undefined ? native : Object.freeze({ ...native, lastCommitAt });
}
