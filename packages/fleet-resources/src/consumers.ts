import { execFile } from "node:child_process";
import { basename } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/** One process in a machine-wide census. Diagnostic only: never admission or signal authority. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  uid: number;
  rssBytes: number;
  /** Recent CPU, where 100 is one core: the kernel's decaying average on macOS, lifetime on Linux. */
  cpuPercent: number;
  executable: string;
}

/** What a holder's process group costs right now. */
export interface ProcessGroupUsage {
  cpuPercent: number;
  rssBytes: number;
  processes: number;
}

/** A process named in a pressure notice, charged to its holder or counted as unleased. */
export interface ResourceConsumer {
  pid: number;
  executable: string;
  cpuPercent: number;
  rssBytes: number;
  /** The heavy permit whose process group holds it; absent when nothing leases it. */
  holder?: { lane: "full" | "light" | "server"; seatId?: string; holderId?: string; executable: string };
  /** The nearest agent harness above it, so unleased work names who started it. */
  startedBy?: { pid: number; executable: string };
}

/** A heavy permit's process group, as the governor records its runner. */
export interface HolderGroup {
  id: string;
  pgid: number;
  lane: "full" | "light" | "server";
  seatId?: string;
  holderId?: string;
  executable: string;
}

const CACHE_MS = 5_000;
const HARNESSES = new Set(["claude", "codex", "opencode", "grok", "pi", "prime-agent", "cursor-agent"]);
let cached: { at: number; rows: ProcessRow[] } | undefined;
let pending: Promise<ProcessRow[]> | undefined;

/**
 * One `ps` over every process, all users, cached for five seconds. It costs about
 * 65 ms for 1,050 processes on the owner's Mac (#332), so callers take it only
 * while a permit is held or pressure is high.
 */
export async function observeProcessTable(): Promise<ProcessRow[]> {
  if (cached && performance.now() - cached.at < CACHE_MS) return cached.rows;
  pending ??= (async () => {
    try {
      const { stdout } = await execute(
        "/bin/ps",
        ["-A", "-ww", "-o", "pid=,ppid=,pgid=,uid=,rss=,%cpu=,comm="],
        { timeout: 2_000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8", killSignal: "SIGKILL" },
      );
      const rows = parseProcessTable(stdout);
      cached = { at: performance.now(), rows };
      return rows;
    } finally {
      pending = undefined;
    }
  })();
  return pending;
}

export function parseProcessTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 7) continue;
    const [pid, ppid, pgid, uid, rss, cpu] = fields.slice(0, 6).map(Number);
    const command = fields.slice(6).join(" ");
    if (![pid, ppid, pgid, uid, rss, cpu].every((value) => Number.isFinite(value))) continue;
    rows.push({
      pid: pid!,
      ppid: ppid!,
      pgid: pgid!,
      // Darwin prints nobody's uid_t as -2.
      uid: uid! < 0 ? uid! + 2 ** 32 : uid!,
      rssBytes: rss! * 1024,
      cpuPercent: cpu!,
      // A versioned install (`…/claude/versions/2.1.316`) is named for its harness.
      executable: (/\/(claude|codex)\/versions\/[^/]+$/u.exec(command)?.[1] ?? basename(command)).slice(
        0,
        128,
      ),
    });
  }
  if (rows.length > 20_000) throw new Error("Process census too large");
  return rows;
}

/** Each holder's process group, summed. A holder with no live member is absent. */
export function chargeHolders(
  rows: readonly ProcessRow[],
  holders: readonly HolderGroup[],
): Map<string, ProcessGroupUsage> {
  const byGroup = new Map<number, ProcessGroupUsage>();
  for (const row of rows) {
    const usage = byGroup.get(row.pgid) ?? { cpuPercent: 0, rssBytes: 0, processes: 0 };
    usage.cpuPercent += row.cpuPercent;
    usage.rssBytes += row.rssBytes;
    usage.processes += 1;
    byGroup.set(row.pgid, usage);
  }
  const charged = new Map<string, ProcessGroupUsage>();
  for (const holder of holders) {
    const usage = byGroup.get(holder.pgid);
    if (usage) charged.set(holder.id, { ...usage, cpuPercent: Math.round(usage.cpuPercent * 10) / 10 });
  }
  return charged;
}

/** The heaviest processes now, each charged to its holder or named unleased with who started it. */
export function topConsumers(
  rows: readonly ProcessRow[],
  holders: readonly HolderGroup[],
  options: { limit?: number; minCpuPercent?: number; exclude?: readonly number[] } = {},
): ResourceConsumer[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const byGroup = new Map(holders.map((holder) => [holder.pgid, holder]));
  const exclude = new Set(options.exclude ?? []);
  return rows
    .filter((row) => !exclude.has(row.pid) && row.cpuPercent >= (options.minCpuPercent ?? 5))
    .sort((a, b) => b.cpuPercent - a.cpuPercent || b.rssBytes - a.rssBytes)
    .slice(0, options.limit ?? 5)
    .map((row) => {
      const holder = byGroup.get(row.pgid);
      let startedBy: ResourceConsumer["startedBy"];
      if (!holder) {
        let parent = byPid.get(row.ppid);
        for (let depth = 0; parent && parent.pid > 1 && depth < 32; depth++) {
          if (HARNESSES.has(parent.executable)) {
            startedBy = { pid: parent.pid, executable: parent.executable };
            break;
          }
          parent = byPid.get(parent.ppid);
        }
      }
      return {
        pid: row.pid,
        executable: row.executable,
        cpuPercent: row.cpuPercent,
        rssBytes: row.rssBytes,
        ...(holder
          ? {
              holder: {
                lane: holder.lane,
                ...(holder.seatId ? { seatId: holder.seatId } : {}),
                ...(holder.holderId ? { holderId: holder.holderId } : {}),
                executable: holder.executable,
              },
            }
          : {}),
        ...(startedBy ? { startedBy } : {}),
      };
    });
}

const size = (bytes: number) =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GiB` : `${Math.round(bytes / 1024 ** 2)} MiB`;
const clean = (text: string) => text.replace(/\p{Cc}/gu, "");

/** "Top consumers: fseventsd PID 88928, unleased, 100% CPU, 31.2 GiB; …" */
export function describeConsumers(consumers: readonly ResourceConsumer[]): string | undefined {
  if (!consumers.length) return undefined;
  return `Top consumers: ${consumers
    .map((consumer) => {
      const owner = consumer.holder
        ? `${consumer.holder.lane === "full" ? "heavy" : consumer.holder.lane} permit${consumer.holder.seatId ? ` of seat ${clean(consumer.holder.seatId)}` : ""}`
        : `unleased${consumer.startedBy ? `, started under ${clean(consumer.startedBy.executable)} PID ${consumer.startedBy.pid}` : ""}`;
      return `${clean(consumer.executable)} PID ${consumer.pid} (${owner}), ${Math.round(consumer.cpuPercent)}% CPU, ${size(consumer.rssBytes)}`;
    })
    .join("; ")}.`;
}

/**
 * How long the one-minute load average takes to fall from `loadRatio` to `limit`
 * once the load stops: it decays with a 60 s time constant. Undefined at or below it.
 */
export function loadRetryAfterMs(loadRatio: number, limit: number): number | undefined {
  if (!(limit > 0) || !(loadRatio > limit)) return undefined;
  return Math.ceil(60_000 * Math.log(loadRatio / limit));
}

/** "Retry in about 2 minutes, once they stop." from a load decay estimate, else a plain retry. */
export function retryLater(retryAfterMs: number | undefined): string {
  if (retryAfterMs === undefined) return "Retry later.";
  const minutes = Math.max(1, Math.round(retryAfterMs / 60_000));
  return `Load falls to the limit about ${minutes} minute${minutes === 1 ? "" : "s"} after that work stops; retry then.`;
}
