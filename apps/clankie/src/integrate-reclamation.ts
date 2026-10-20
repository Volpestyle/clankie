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
 * only download-store cleanup, which neither changes records nor removes trees.
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
