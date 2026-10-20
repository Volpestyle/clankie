import type { IntegrationBatch } from "@clankie/protocol/integrate";
import { readFile, lstat, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { withDirectoryLock } from "./deploy-holds.ts";
import { processWorkingDirectories } from "./process-working-directories.ts";
import { removeDirectory } from "./remove-directory.ts";

const execute = promisify(execFile);

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Stores are populated with --package-import-method=copy; installed trees never depend on them. */
export async function reclaimCopiedInstallStores(
  root: string,
  logs: string[],
  guard: () => Promise<void>,
  result: { reclaimed: string[]; freedBytes: number },
): Promise<void> {
  const isolation = join(root, "isolation");
  if (!(await pathExists(isolation))) return;
  if ((await realpath(root)) !== root || (await realpath(isolation)) !== isolation)
    throw Error("isolation_alias");
  for (const name of ["core", "app"]) {
    const environment = join(isolation, name);
    if (!(await pathExists(environment))) continue;
    if ((await realpath(environment)) !== environment) throw Error("isolation_alias");
    for (const store of ["pnpm-store", "npm-cache"]) {
      const path = join(environment, store);
      if (!(await pathExists(path))) continue;
      if ((await realpath(path)) !== path) throw Error("isolation_alias");
      if (logs.some((log) => log === path || log.startsWith(`${path}/`)))
        throw Error("isolation_contains_logs");
      if ((await processWorkingDirectories()).some((cwd) => cwd === root || cwd.startsWith(`${root}/`)))
        throw Error("live_cwd");
      const { stdout } = await execute("du", ["-sk", path]);
      const bytes = Number(stdout.trim().split(/\s/u)[0]) * 1024;
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw Error("isolation_size_unknown");
      await guard();
      await removeDirectory(path, { force: true });
      result.reclaimed.push(path);
      result.freedBytes += bytes;
    }
  }
}

/**
 * An idle queue permits its normal scratch sweep. A proven busy queue permits
 * reclamation fenced by the durable receipt census and live-process guards.
 * Unknown owners never authorize the fallback.
 */
export async function withReclamationWindow<T>(
  directory: string,
  sweep: (busy: boolean) => Promise<T>,
): Promise<T> {
  let entered = false;
  try {
    return await withDirectoryLock(join(directory, "queue.lock"), async () => {
      entered = true;
      return sweep(false);
    });
  } catch (error) {
    if (
      entered ||
      !(error instanceof Error) ||
      !error.message.startsWith("Integration operation busy; retained lock:")
    )
      throw error;
    const owner = JSON.parse(await readFile(join(directory, "queue.lock", "owner.json"), "utf8")) as {
      pid?: unknown;
      at?: unknown;
    };
    const since = typeof owner.at === "string" ? Date.parse(owner.at) : NaN;
    if (
      typeof owner.pid !== "number" ||
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      !Number.isFinite(since) ||
      since > Date.now()
    )
      throw error;
    // Permission failures and a just-dead owner retain the original refusal.
    try {
      process.kill(owner.pid, 0);
    } catch {
      throw error;
    }
    return sweep(true);
  }
}

/** A receipt keeps its own state while a later attempt carries its result. */
export function integrationReclamationState(
  record: IntegrationBatch,
  shared?: IntegrationBatch,
): IntegrationBatch["state"] {
  if (!record.batchId || !shared || !["queued", "passed", "held", "partial"].includes(record.state))
    return record.state;
  if (shared.state === "pushed") return "pushed";
  if (shared.state === "interrupted" && record.restartRecovery !== true) return "interrupted";
  // A failed singleton has no further isolation retry. A shared failure still
  // needs its queued member receipts to fence the failure-to-retry window.
  if (shared.state === "failed" && (shared.members ?? [shared.request]).length === 1) return "failed";
  return record.state;
}

/** Durable dependencies fence startup recovery before in-memory retry jobs exist. */
export function integrationRetrySources(records: ReadonlyMap<string, IntegrationBatch>): Set<string> {
  const sources = new Set<string>();
  const active = new Set(["queued", "composing", "installing", "gating", "isolating", "pushing"]);
  for (const record of records.values()) {
    const shared = record.batchId ? records.get(record.batchId) : record;
    // Member receipts can still say queued while their shared attempt has just
    // failed. Those pointers precede the gate and fence the failure→retry window.
    const state = integrationReclamationState(record, shared);
    if (state === "pushed") continue;
    const recoverable = record.restartRecovery === true && state === "interrupted";
    // Held receipts can preserve their attestation while an in-memory regate
    // runs. Keep their lineage until an unambiguous terminal completion too.
    const resumable = ["passed", "held", "partial"].includes(state);
    if (!active.has(state) && !recoverable && !resumable) continue;
    sources.add(record.id);
    for (const source of [
      record.batchId,
      record.isolation?.rootBatchId,
      record.interruptionRetry?.batchId,
      ...(record.attempts ?? []),
      ...record.repos.map((repo) => repo.gateReuse?.batchId),
    ])
      if (source) sources.add(source);
  }
  return sources;
}
