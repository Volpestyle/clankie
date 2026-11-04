import { appendFile, rename, stat } from "node:fs/promises";
import { loadavg } from "node:os";
import { basename, join } from "node:path";

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
/** Days of permits per file (#599), so wait times can be compared across a change. */
const leaseRecordMaxBytes = 16 * 1_048_576;

// `-c`/`-e` take a whole shell or interpreter script, which can carry any secret. Case
// matters: `-C dir` (pnpm, git), `-E` and `-U` are ordinary arguments worth keeping.
const scriptOrUserFlag = /^(?:-H|-c|-e|-u|--eval|--user)$/u;
const secretName = String.raw`--?[\w-]*(?:token|secret|password|auth|key|header|cookie)[\w-]*`;
const secretNamedFlag = new RegExp(`^${secretName}$`, "iu");
const secretFlagValue = new RegExp(`^((?:--eval|--user|${secretName})=).+$`, "iu");
const urlUserinfo = /([a-z][\w+.-]*:\/\/)[^/@\s]+@/giu;

/** The command line, with environment assignments, scripts and credentials withheld. */
export function leaseCommand(command: string, args: readonly string[]): string {
  const shown = args.map((arg, index) =>
    /^[A-Za-z_][A-Za-z0-9_]*=/u.test(arg)
      ? `${arg.slice(0, arg.indexOf("="))}=***`
      : index > 0 && (scriptOrUserFlag.test(args[index - 1]!) || secretNamedFlag.test(args[index - 1]!))
        ? "***"
        : arg.replace(secretFlagValue, "$1***").replace(urlUserinfo, "$1***@"),
  );
  return [basename(command), ...shown].join(" ").slice(0, 256);
}

/** Recording never fails the permit it describes. */
export async function recordLease(directory: string, record: Omit<LeaseRecord, "atMs" | "load1">) {
  const line = { atMs: Date.now(), ...record, load1: round(loadavg()[0]!) };
  // allow-swallowed-rejection -- history is best effort; the permit it describes must not fail.
  await appendRecords(directory, leaseRecordFile, [line], leaseRecordMaxBytes).catch(() => undefined);
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
