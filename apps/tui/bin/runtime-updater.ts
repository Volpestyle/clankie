/** Local host updater: one private operation, one detached helper, no mutation retry. */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertPinnedRuntime, installCommand, pinnedCommit, type InstallCommand } from "./pinned-runtime.ts";
import { operationId, object, privateDirectory, readPrivateJson, writePrivateJson } from "./update-files.ts";
import {
  readRuntimeUpdate,
  writeRuntimeUpdate,
  type RuntimeBootIdentity,
  type RuntimeUpdatePlan,
  type RuntimeUpdateResult,
} from "./runtime-update.ts";

export interface UpdateAuthority {
  guard(): Promise<void>;
  current(): boolean;
}
interface RuntimeUpdateStatus {
  readonly runtime: RuntimeBootIdentity;
  readonly latest?: RuntimeUpdateResult;
  readonly pending?: string;
  readonly needsReconciliation?: boolean;
}
export interface RuntimeUpdater {
  status(): RuntimeUpdateStatus;
  request(
    ref: string,
    authority: UpdateAuthority,
  ): Promise<RuntimeUpdateStatus & { readonly accepted: boolean }>;
}
export interface RuntimeUpdaterOptions {
  readonly repoRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly run?: InstallCommand;
  readonly spawnHelper?: (
    command: string,
    args: readonly string[],
    options: Parameters<typeof spawn>[2],
  ) => ChildProcess;
  readonly materialize?: (directory: string) => Promise<Readonly<Record<string, string>>>;
}
const HELPER_FILES = [
  "runtime-update-helper.mjs",
  "runtime-update.ts",
  "pinned-runtime.ts",
  "update-files.ts",
] as const;
export async function materializeUpdateHelper(
  directory: string,
  sourceRoot = import.meta.dirname,
): Promise<Readonly<Record<string, string>>> {
  const files: Record<string, string> = {};
  for (const name of HELPER_FILES) {
    const source = join(sourceRoot, name);
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error("Invalid updater source");
    const destination = join(directory, name);
    copyFileSync(source, destination);
    chmodSync(destination, 0o400);
    files[name] = createHash("sha256").update(readFileSync(destination)).digest("hex");
  }
  writePrivateJson(join(directory, "helper.json"), { files });
  return Object.freeze(files);
}
export function verifyUpdateHelper(directory: string, files: Readonly<Record<string, string>>): void {
  privateDirectory(directory);
  for (const name of HELPER_FILES) {
    const path = join(directory, name);
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o277) !== 0 ||
      stat.size > 128 * 1024 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      createHash("sha256").update(readFileSync(path)).digest("hex") !== files[name]
    )
      throw Error("Materialized update helper changed");
  }
}
export function createRuntimeUpdater(options: RuntimeUpdaterOptions): RuntimeUpdater {
  const env = options.env ?? process.env;
  const run = options.run ?? installCommand;
  const home = realpathSync(env.HOME || homedir());
  const checkout = realpathSync(options.repoRoot);
  const runtimePath = resolve(env.CLANKIE_RUNTIME_DIR || join(home, ".clankie", "pinned"));
  const updates = join(home, ".clankie", "updates");
  const lock = join(updates, "active");
  const boot = Object.freeze({
    root: checkout,
    commit: pinnedCommit(checkout, "HEAD", run),
    instanceId: randomUUID(),
    pid: process.pid,
  });
  const initialize = () => {
    const parent = join(home, ".clankie");
    if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
    const parentStat = lstatSync(parent);
    if (
      !parentStat.isDirectory() ||
      realpathSync(parent) !== parent ||
      (parentStat.mode & 0o022) !== 0 ||
      (process.getuid && parentStat.uid !== process.getuid())
    )
      throw Error("Invalid update parent directory");
    if (!existsSync(updates)) mkdirSync(updates, { mode: 0o700 });
    privateDirectory(updates);
  };
  const activeId = (): string | undefined => {
    if (!existsSync(lock)) return undefined;
    privateDirectory(lock);
    return operationId(object(readPrivateJson(join(lock, "operation.json"))).id);
  };
  const latest = (): RuntimeUpdateResult | undefined => {
    if (!existsSync(join(updates, "latest.json"))) return undefined;
    const id = operationId(object(readPrivateJson(join(updates, "latest.json"))).id);
    const result = readRuntimeUpdate(join(updates, id));
    if (result.id !== id) throw Error("Update result identity changed");
    return result;
  };
  const safeTerminal = (result: RuntimeUpdateResult) =>
    result.phase === "healthy" ||
    result.phase === "rolled-back" ||
    result.phase === "refused" ||
    (result.phase === "failed" && result.reason === "pre-cutover-failed");
  const status = (): RuntimeUpdateStatus => {
    const result = latest();
    const id = activeId();
    return {
      runtime: boot,
      ...(result === undefined ? {} : { latest: result }),
      ...(id === undefined ? {} : { pending: id }),
      ...(id !== undefined &&
      result?.id === id &&
      ["stop-unconfirmed", "failed"].includes(result.phase) &&
      !safeTerminal(result)
        ? { needsReconciliation: true }
        : {}),
    };
  };
  return {
    status,
    async request(ref, authority) {
      await authority.guard();
      if (!authority.current()) throw Error("Update authority expired");
      initialize();
      const active = activeId();
      if (active !== undefined) {
        if (!existsSync(join(updates, active, "result.json"))) return { ...status(), accepted: false };
        const previous = readRuntimeUpdate(join(updates, active));
        if (previous.id !== active || !safeTerminal(previous)) return { ...status(), accepted: false };
        // Terminal result is written only after helper effects finish. PID is never recovery proof.
        // A cross-process retirement claim prevents two callers deleting each other's new lock.
        try {
          closeSync(openSync(join(lock, "retiring"), "wx", 0o600));
        } catch {
          return { ...status(), accepted: false };
        }
        if (activeId() !== active) throw Error("Update lock changed during retirement");
        rmSync(lock, { recursive: true });
      }
      const oldCommit = assertPinnedRuntime(checkout, runtimePath, run);
      if (boot.root !== realpathSync(runtimePath) || boot.commit !== oldCommit)
        throw Error("Running service is not the exact pinned runtime");
      const newCommit = pinnedCommit(checkout, ref, run);
      // The running pin is moved during cutover; all git operations need a stable repository cwd.
      const repository = dirname(
        realpathSync(resolve(checkout, run("git", ["rev-parse", "--git-common-dir"], checkout))),
      );
      const id = randomUUID();
      const directory = join(updates, id);
      mkdirSync(lock, { mode: 0o700 });
      writePrivateJson(join(lock, "operation.json"), { id });
      mkdirSync(directory, { mode: 0o700 });
      let accepted = false;
      try {
        const plan: RuntimeUpdatePlan = {
          id,
          ref,
          checkout: repository,
          runtime: runtimePath,
          home,
          directory,
          oldCommit,
          newCommit,
          oldInstanceId: boot.instanceId,
        };
        writePrivateJson(join(directory, "plan.json"), plan);
        const helperHashes = await (options.materialize ?? materializeUpdateHelper)(directory);
        // Commit point: no awaited preparation remains between fresh authority and physical scheduling.
        await authority.guard();
        verifyUpdateHelper(directory, helperHashes);
        if (!authority.current()) throw Error("Update authority expired");
        const result: RuntimeUpdateResult = {
          id,
          ref,
          oldCommit,
          newCommit,
          phase: "scheduled",
          updatedAt: new Date().toISOString(),
        };
        writeRuntimeUpdate(directory, result);
        writePrivateJson(join(updates, "latest.json"), { id });
        accepted = true;
        const log = openSync(join(directory, "helper.log"), "ax", 0o600);
        try {
          const helperEnv: NodeJS.ProcessEnv = { ...env, pnpm_config_verify_deps_before_run: "false" };
          for (const name of [
            "PI_SESSION_FILE",
            "PI_SESSION_ID",
            "NODE_OPTIONS",
            "NODE_PATH",
            "CLANKIE_LAUNCHER_PATH",
          ])
            delete helperEnv[name];
          const child = (options.spawnHelper ?? spawn)(
            process.execPath,
            [join(directory, "runtime-update-helper.mjs")],
            { cwd: directory, env: helperEnv, detached: true, stdio: ["ignore", log, log] },
          );
          child.on("error", () => {
            /* Acceptance is durable; uncertain spawn is never resent. */
          });
          child.unref();
        } finally {
          closeSync(log);
        }
        return { ...status(), accepted: true };
      } catch (error) {
        if (!accepted) {
          // Only this unaccepted preparation owns the lock. No helper has been spawned.
          if (activeId() === id) rmSync(lock, { recursive: true });
          rmSync(directory, { recursive: true });
          throw error;
        }
        return { ...status(), accepted: true, needsReconciliation: true };
      }
    },
  };
}
