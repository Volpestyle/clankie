import { execFile } from "node:child_process";
import { appendFile, rename, stat, statfs } from "node:fs/promises";
import { cpus, loadavg } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Append-only history beside the journal (VUH-2933): what was admitted and
 * what the machine was doing, so a load spike can be explained afterwards.
 * Each file rotates to one `.1` predecessor, so the pair stays bounded.
 */
export async function appendRecords(
  directory: string,
  name: string,
  records: readonly object[],
  maxBytes = 262_144,
): Promise<void> {
  const path = join(directory, name);
  // Unlocked: two writers that both see an oversized file can rotate twice and
  // drop one generation. Acceptable for best-effort history.
  try {
    if ((await stat(path)).size > maxBytes) await rename(path, `${path}.1`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await appendFile(path, records.map((record) => `${JSON.stringify(record)}\n`).join(""), { mode: 0o600 });
}

/** Admission and release of one heavy permit, written by the command that holds it. */
export interface LeaseRecord {
  atMs: number;
  event: "admitted" | "released";
  leaseId: string;
  lane: "full" | "light" | "server";
  holderId?: string;
  seatId?: string;
  /** Executable basename and arguments, truncated. */
  command: string;
  waitedMs?: number;
  heldMs?: number;
  exitCode?: number;
  load1: number;
}

const leaseRecordFile = "leases.jsonl";
const machineSampleFile = "samples.jsonl";
/** About two days of 30-second samples per file. */
const machineSampleMaxBytes = 4 * 1_048_576;

const secretFlag = /^(?:-H|--?[\w-]*(?:token|secret|password|auth|key|header|cookie)[\w-]*)$/iu;
const secretFlagValue = /^(--?[\w-]*(?:token|secret|password|auth|key|header|cookie)[\w-]*=).+$/iu;

/** The command line, with environment assignments and secret-looking flag values withheld. */
export function leaseCommand(command: string, args: readonly string[]): string {
  const shown = args.map((arg, index) =>
    /^[A-Za-z_][A-Za-z0-9_]*=/u.test(arg)
      ? `${arg.slice(0, arg.indexOf("="))}=***`
      : index > 0 && secretFlag.test(args[index - 1]!)
        ? "***"
        : arg.replace(secretFlagValue, "$1***"),
  );
  return [basename(command), ...shown].join(" ").slice(0, 256);
}

/** Recording never fails the permit it describes. */
export async function recordLease(directory: string, record: Omit<LeaseRecord, "atMs" | "load1">) {
  const line = { atMs: Date.now(), ...record, load1: round(loadavg()[0]!) };
  // allow-swallowed-rejection -- history is best effort; the permit it describes must not fail.
  await appendRecords(directory, leaseRecordFile, [line]).catch(() => undefined);
}

let ticks: { busy: number; total: number } | undefined;
function cpuRatio(): number | undefined {
  let busy = 0;
  let total = 0;
  for (const { times } of cpus()) {
    const used = times.user + times.nice + times.sys + times.irq;
    busy += used;
    total += used + times.idle;
  }
  const previous = ticks;
  ticks = { busy, total };
  return previous && total > previous.total
    ? round((busy - previous.busy) / (total - previous.total))
    : undefined;
}

/** The busiest processes by the kernel's recent CPU share, from one `ps` read. */
async function topProcesses(count: number) {
  const { stdout } = await run("ps", ["-A", "-o", "pid=,pcpu=,rss=,comm="], { maxBuffer: 8 * 1_048_576 });
  return stdout
    .split("\n")
    .flatMap((line) => {
      const match = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/u.exec(line);
      return match
        ? [
            {
              pid: Number(match[1]),
              cpu: Number(match[2]),
              rssMb: Math.round(Number(match[3]) / 1024),
              command: basename(match[4]!.trim()).slice(0, 64),
            },
          ]
        : [];
    })
    .sort((a, b) => b.cpu - a.cpu)
    .slice(0, count);
}

/**
 * One machine sample: load, the share of all cores busy since the previous
 * sample, free disk under `directory`, and the five busiest processes.
 * A part that cannot be read is left out rather than failing the sample.
 */
export async function recordMachineSample(directory: string): Promise<void> {
  const [load1, load5, load15] = loadavg().map(round) as [number, number, number];
  const ratio = cpuRatio();
  // allow-swallowed-rejection -- an unreadable part is left out of the sample, as documented above.
  const disk = await statfs(directory).catch(() => undefined);
  // allow-swallowed-rejection -- an unreadable part is left out of the sample, as documented above.
  const top = await topProcesses(5).catch(() => undefined);
  await appendRecords(
    directory,
    machineSampleFile,
    [
      {
        atMs: Date.now(),
        load: [load1, load5, load15],
        cores: cpus().length,
        ...(ratio === undefined ? {} : { cpuRatio: ratio }),
        ...(disk ? { freeDiskGb: round((disk.bavail * disk.bsize) / 1024 ** 3) } : {}),
        ...(top ? { top } : {}),
      },
    ],
    machineSampleMaxBytes,
  );
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

const bulkOperationFile = "bulk-ops.jsonl";

/**
 * Service-side bulk filesystem work runs outside heavy admission, so its
 * timing is recorded when it ends: one line per run, failed or not.
 */
export async function recordBulkOperation<T>(
  directory: string,
  operation: string,
  work: () => Promise<T>,
  summary: (result: T) => object,
): Promise<T> {
  const startedAtMs = Date.now();
  const write = (fields: object) => {
    const line = { startedAtMs, durationMs: Date.now() - startedAtMs, operation, ...fields };
    // allow-swallowed-rejection -- history is best effort; the bulk operation's own outcome stands.
    return appendRecords(directory, bulkOperationFile, [line]).catch(() => undefined);
  };
  try {
    const result = await work();
    await write({ outcome: "ok", ...summary(result) });
    return result;
  } catch (error) {
    await write({ outcome: "failed" });
    throw error;
  }
}
