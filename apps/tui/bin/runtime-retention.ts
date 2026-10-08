/** Runtime worktrees only: operation journals and worker checkouts are never deleted. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeSync,
  constants,
  fstatSync,
  fsyncSync,
  unlinkSync,
} from "node:fs";
import { readlink, readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { checkoutGit, matchesProjectWorktree, observeLocalProjectGitWorktree } from "@clankie/settings";
import {
  commitString,
  object,
  operationId,
  privateDirectory,
  readPrivateJson,
  writePrivateJson,
} from "./update-files.ts";
import {
  readRuntimeUpdate,
  errorText,
  type RuntimeBootIdentity,
  type RuntimeUpdateResult,
} from "./runtime-update.ts";

export interface RuntimeRetentionResult {
  readonly outcome: "completed" | "blocked";
  readonly at: string;
  readonly removedCount: number;
  readonly retainedCount: number;
  /** Lists are bounded; the complete effect journal is retention.log. */
  readonly removed: readonly string[];
  readonly retained: readonly { path: string; reason: string }[];
  readonly error?: string;
}
export const RUNTIME_RETENTION_PENDING = "retention-pending.json";

export class RuntimeMaintenanceBusyError extends Error {
  constructor() {
    super("Runtime maintenance is already active");
  }
}

/** Same lock for admission and retention: a cleanup cannot race a new cutover. */
export async function withRuntimeMaintenance<T>(updates: string, work: () => Promise<T>): Promise<T> {
  privateDirectory(updates);
  const lock = join(updates, "maintenance.lock");
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new RuntimeMaintenanceBusyError();
    throw error;
  }
  const owned = lstatSync(lock);
  try {
    writePrivateJson(join(lock, "owner.json"), { pid: process.pid, at: new Date().toISOString() });
    return await work();
  } finally {
    const current = lstatSync(lock);
    if (current.dev === owned.dev && current.ino === owned.ino && current.isDirectory())
      rmSync(lock, { recursive: true });
  }
}

/** Kernel cwd/executable observations plus live PIDs; arguments and secrets are never returned. */
async function runtimeProcesses(): Promise<{ paths: string[]; pids: Set<number> }> {
  const exec = promisify(execFile);
  const uid = process.getuid?.();
  if (uid === undefined) throw Error("runtime_process_inventory_unsupported");
  if (process.platform === "darwin") {
    const options = { encoding: "utf8" as const, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 };
    const rows = (await exec("ps", ["-Ao", "pid=,uid=,stat="], options)).stdout.trim().split("\n");
    const pids = new Set<number>();
    for (const row of rows) {
      const match = /^\s*(\d+)\s+(-?\d+)\s+(\S+)\s*$/u.exec(row);
      if (!match) throw Error("runtime_process_inventory_unverified");
      if (Number(match[2]) === uid && !match[3]!.startsWith("Z")) pids.add(Number(match[1]));
    }
    const fields = (await exec("lsof", ["-nP", "-a", "-u", String(uid), "-d", "cwd", "-Fpn"], options)).stdout
      .trim()
      .split("\n");
    const paths: string[] = [];
    const observed = new Set<number>();
    for (const field of fields) {
      if (/^p\d+$/u.test(field)) observed.add(Number(field.slice(1)));
      else if (field === "fcwd")
        continue; // lsof always emits file descriptor fields.
      else if (field.startsWith("n/")) paths.push(field.slice(1));
      else throw Error("runtime_process_inventory_unverified");
    }
    // Every process present in both observations must have a kernel file observation.
    // libproc reads actual executable paths without collecting every mapped txt file
    // (which can produce tens of MiB on a busy desktop). Python is the existing native helper dependency.
    const executableSource = `import ctypes,json,os,sys
lib=ctypes.CDLL('/usr/lib/libproc.dylib',use_errno=True)
lib.proc_pidpath.argtypes=[ctypes.c_int,ctypes.c_void_p,ctypes.c_uint32]
lib.proc_pidpath.restype=ctypes.c_int
paths=[]
missing=[]
for pid in json.loads(sys.argv[1]):
 b=ctypes.create_string_buffer(4096)
 n=lib.proc_pidpath(pid,b,4096)
 if n<=0 or n>=4096:
  try: os.kill(pid,0)
  except ProcessLookupError: continue
  missing.append(pid)
  continue
 path=os.fsdecode(b.value)
 if not os.path.isabs(path): raise RuntimeError('Runtime executable path unavailable')
 paths.append(path)
print(json.dumps({"paths":paths,"missing":missing}))`;
    const executables = JSON.parse(
      (await exec("python3", ["-c", executableSource, JSON.stringify([...pids])], options)).stdout,
    ) as { paths?: unknown; missing?: unknown };
    if (
      !Array.isArray(executables.paths) ||
      executables.paths.some((path) => typeof path !== "string" || !path.startsWith("/")) ||
      !Array.isArray(executables.missing) ||
      executables.missing.some((pid) => !Number.isSafeInteger(pid) || !pids.has(pid))
    )
      throw Error("runtime_executable_inventory_unverified");
    paths.push(...(executables.paths as string[]));
    // An unlinked executable can make proc_pidpath return ENOENT while still running.
    // Read kernel txt mappings only for those PIDs, bounded individually, rather than
    // collecting every mapping on the desktop. Missing live mappings fail closed.
    for (const pid of executables.missing as number[]) {
      let mappings: string[] = [];
      try {
        const output = (await exec("lsof", ["-nP", "-a", "-p", String(pid), "-d", "txt", "-Fpn"], options))
          .stdout;
        const fields = output.trim().split("\n");
        for (const field of fields) {
          if (field === `p${pid}` || field === "ftxt") continue;
          if (!field.startsWith("n/")) throw Error("runtime_executable_inventory_unverified");
          mappings.push(field.slice(1));
        }
      } catch (error) {
        const state = (
          await exec("ps", ["-p", String(pid), "-o", "stat="], options).catch(() => ({ stdout: "" }))
        ).stdout.trim();
        if (state.startsWith("Z")) continue;
        try {
          process.kill(pid, 0);
        } catch (gone) {
          if ((gone as NodeJS.ErrnoException).code === "ESRCH") continue;
        }
        throw error;
      }
      if (mappings.length === 0) throw Error("runtime_executable_inventory_incomplete");
      paths.push(...mappings);
    }
    const after = (await exec("ps", ["-Ao", "pid=,uid=,stat="], options)).stdout;
    for (const row of after.trim().split("\n")) {
      const match = /^\s*(\d+)\s+(-?\d+)\s+(\S+)\s*$/u.exec(row);
      if (!match) throw Error("runtime_process_inventory_unverified");
      const pid = Number(match[1]);
      if (Number(match[2]) === uid && !match[3]!.startsWith("Z") && pids.has(pid) && !observed.has(pid))
        throw Error("runtime_process_inventory_incomplete");
      if (Number(match[2]) === uid && !match[3]!.startsWith("Z")) pids.add(pid);
    }
    if (!observed.has(process.pid)) throw Error("runtime_process_inventory_incomplete");
    return { paths, pids };
  }
  if (process.platform === "linux") {
    const paths: string[] = [],
      pids = new Set<number>();
    for (const name of await readdir("/proc")) {
      if (!/^\d+$/u.test(name)) continue;
      try {
        if ((await stat(join("/proc", name))).uid !== uid) continue;
        const cwd = await readlink(join("/proc", name, "cwd"));
        const executable = await readlink(join("/proc", name, "exe"));
        pids.add(Number(name));
        paths.push(cwd, executable);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // A process exiting during observation is not a negative liveness claim.
      }
    }
    if (!pids.has(process.pid)) throw Error("runtime_process_inventory_incomplete");
    return { paths, pids };
  }
  throw Error("runtime_process_inventory_unsupported");
}

interface UpdateRecord {
  directory: string;
  result: RuntimeUpdateResult;
  raw: unknown;
}

export async function retainRuntimeWorktrees(input: {
  home: string;
  checkout: string;
  runtime: string;
  boot: RuntimeBootIdentity;
  protectedUpdateIds: () => Promise<readonly string[]>;
}): Promise<RuntimeRetentionResult> {
  const updates = join(input.home, ".clankie", "updates");
  const removed: string[] = [],
    retained: { path: string; reason: string }[] = [];
  const report = (error?: string): RuntimeRetentionResult => {
    const value = {
      outcome: error ? ("blocked" as const) : ("completed" as const),
      at: new Date().toISOString(),
      removedCount: removed.length,
      retainedCount: retained.length,
      removed: removed.slice(0, 64),
      retained: retained.slice(0, 64),
      ...(error ? { error: error.slice(0, 1024) } : {}),
    };
    // Fit the existing private JSON envelope even for long paths/failure details.
    // Counts and the complete audit remain intact when diagnostic lists truncate.
    while (Buffer.byteLength(JSON.stringify(value)) > 24_576) {
      if (value.retained.length) value.retained.pop();
      else value.removed.pop();
    }
    return value;
  };
  const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + "/");
  const audit = (event: unknown) => {
    const fd = openSync(
      join(updates, "retention.log"),
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o077 || stat.uid !== process.getuid?.())
        throw Error("runtime_retention_audit_unverified");
      writeSync(fd, JSON.stringify({ at: new Date().toISOString(), ...object(event) }) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  try {
    return await withRuntimeMaintenance(updates, async () => {
      try {
        const pendingPath = join(updates, RUNTIME_RETENTION_PENDING);
        if (existsSync(pendingPath)) throw Error("runtime_retention_effect_unconfirmed");
        if (
          realpathSync(input.runtime) !== input.runtime ||
          input.boot.root !== input.runtime ||
          (await checkoutGit(input.runtime, ["rev-parse", "HEAD"])).trim() !== input.boot.commit
        )
          throw Error("runtime_retention_live_pin_unverified");
        const common = realpathSync(
          resolve(
            input.checkout,
            (await checkoutGit(input.checkout, ["rev-parse", "--git-common-dir"])).trim(),
          ),
        );
        if (
          realpathSync(
            resolve(
              input.runtime,
              (await checkoutGit(input.runtime, ["rev-parse", "--git-common-dir"])).trim(),
            ),
          ) !== common ||
          (await checkoutGit(input.runtime, ["rev-parse", "--show-toplevel"])).trim() !== input.runtime ||
          (await checkoutGit(input.runtime, ["branch", "--show-current"])).trim() ||
          (await checkoutGit(input.runtime, ["status", "--porcelain", "--untracked-files=all"]))
        )
          throw Error("runtime_retention_live_pin_unverified");
        const root = {
          id: "runtime-retention",
          machineId: "local",
          platform: "posix" as const,
          path: updates,
          repoPath: input.checkout,
          commonDirectory: common,
        };
        const records = (): UpdateRecord[] =>
          readdirSync(updates)
            .filter((name) => /^[a-f0-9-]{36}$/u.test(name))
            .map((name) => {
              const id = operationId(name),
                directory = join(updates, id);
              privateDirectory(directory);
              const raw = {
                plan: readPrivateJson(join(directory, "plan.json")),
                result: readPrivateJson(join(directory, "result.json")),
              };
              const plan = object(raw.plan),
                result = readRuntimeUpdate(directory);
              if (
                plan.id !== id ||
                result.id !== id ||
                plan.home !== input.home ||
                plan.directory !== directory ||
                plan.runtime !== input.runtime ||
                typeof plan.checkout !== "string" ||
                plan.checkout !== input.checkout ||
                realpathSync(plan.checkout) !== input.checkout ||
                commitString(plan.oldCommit) !== result.oldCommit ||
                commitString(plan.newCommit) !== result.newCommit
              )
                throw Error("runtime_retention_operation_unverified");
              return {
                directory,
                result,
                raw,
              };
            });
        const snapshot = records();
        const held = [...(await input.protectedUpdateIds())].sort();
        if (held.some((id) => !snapshot.some((row) => row.result.id === id)))
          throw Error("runtime_retention_canary_hold_unverified");
        const latest = operationId(object(readPrivateJson(join(updates, "latest.json"))).id);
        const current = snapshot.find((row) => row.result.id === latest);
        if (
          !current ||
          current.result.phase !== "healthy" ||
          current.result.healthy !== true ||
          current.result.newCommit !== input.boot.commit ||
          current.result.canary?.state !== "passed" ||
          current.result.canary.holdReleased !== true
        )
          throw Error("runtime_retention_canary_or_recovery_pending");
        const previous = join(current.directory, "previous");
        const previousObservation = existsSync(previous)
          ? await observeLocalProjectGitWorktree(root, previous)
          : undefined;
        if (
          !previousObservation ||
          !matchesProjectWorktree(root, previous, previousObservation) ||
          (await checkoutGit(previous, ["rev-parse", "HEAD"])).trim() !== current.result.oldCommit
        )
          throw Error("runtime_retention_previous_unverified");
        const activePath = join(updates, "active", "operation.json");
        const active = existsSync(activePath)
          ? operationId(object(readPrivateJson(activePath)).id)
          : undefined;
        if (active !== undefined && active !== latest) throw Error("runtime_retention_update_in_flight");
        const fingerprints = snapshot.map((row) => row.raw);
        const guard = () => {
          if (
            !isDeepStrictEqual(
              records().map((row) => row.raw),
              fingerprints,
            ) ||
            operationId(object(readPrivateJson(join(updates, "latest.json"))).id) !== latest ||
            (existsSync(activePath) ? operationId(object(readPrivateJson(activePath)).id) : undefined) !==
              active ||
            realpathSync(input.runtime) !== input.runtime
          )
            throw Error("runtime_retention_state_changed");
        };
        const protectedCommits = new Set<string>();
        const protectedOperations = new Set<string>();
        for (const row of snapshot) {
          const result = row.result;
          // Legacy healthy results without an armed canary are terminal too.
          const terminal =
            result.phase === "healthy" &&
            result.healthy === true &&
            (result.canary
              ? result.canary.state === "passed" && result.canary.holdReleased === true
              : !existsSync(join(row.directory, "canary-policy.json")));
          if (
            held.includes(result.id) ||
            (!terminal &&
              result.phase !== "refused" &&
              !(result.phase === "failed" && result.reason === "pre-cutover-failed"))
          ) {
            protectedOperations.add(result.id);
            protectedCommits.add(result.oldCommit);
            protectedCommits.add(result.newCommit);
            if (result.canary?.previousHealthyCommit)
              protectedCommits.add(result.canary.previousHealthyCommit);
          }
        }
        for (const row of snapshot)
          for (const name of ["previous", "staged"]) {
            const path = join(row.directory, name);
            if (!existsSync(path)) continue;
            const keep = (reason: string) => {
              retained.push({ path, reason });
              audit({ event: "retained", path, reason });
            };
            if (path === previous) {
              keep("previous_runtime");
              continue;
            }
            if (protectedOperations.has(row.result.id)) {
              keep("canary_or_recovery_runtime");
              continue;
            }
            try {
              // Plan repository names are evidence, never command destinations.
              const before = await observeLocalProjectGitWorktree(root, path);
              if (!before || !matchesProjectWorktree(root, path, before) || before.worktreePath !== path)
                throw Error("runtime_worktree_unverified");
              const head = (await checkoutGit(path, ["rev-parse", "HEAD"])).trim();
              if (head !== (name === "previous" ? row.result.oldCommit : row.result.newCommit))
                throw Error("runtime_worktree_commit_changed");
              if (protectedCommits.has(head)) {
                keep("protected_runtime_commit");
                continue;
              }
              const log = openSync(
                join(row.directory, "helper.log"),
                constants.O_RDONLY | constants.O_NOFOLLOW,
              );
              let final: Record<string, unknown>;
              try {
                const stat = fstatSync(log);
                if (
                  !stat.isFile() ||
                  stat.nlink !== 1 ||
                  stat.mode & 0o077 ||
                  stat.uid !== process.getuid?.()
                )
                  throw Error("runtime_helper_completion_unverified");
                const tail = Buffer.alloc(Math.min(stat.size, 32_769));
                const length = readSync(log, tail, 0, tail.length, stat.size - tail.length);
                final = object(
                  JSON.parse(tail.subarray(0, length).toString("utf8").trimEnd().split("\n").at(-1) ?? ""),
                );
              } finally {
                closeSync(log);
              }
              if (
                final.id !== row.result.id ||
                final.phase !== row.result.phase ||
                final.oldCommit !== row.result.oldCommit ||
                final.newCommit !== row.result.newCommit
              )
                throw Error("runtime_helper_completion_unverified");
              if (
                (await checkoutGit(path, ["branch", "--show-current"])).trim() ||
                (await checkoutGit(path, ["status", "--porcelain", "--untracked-files=all"]))
              )
                throw Error("runtime_worktree_changed");
              const registration = (
                await checkoutGit(input.checkout, ["worktree", "list", "--porcelain", "-z"])
              )
                .split("\0\0")
                .find((record) => record.split("\0")[0] === `worktree ${path}`);
              if (
                !registration ||
                registration.split("\0").some((field) => /^(?:locked|prunable)(?: |$)/u.test(field))
              )
                throw Error("runtime_worktree_locked_or_prunable");
              const live = (processes: Awaited<ReturnType<typeof runtimeProcesses>>) =>
                processes.paths.some((value) => inside(path, value) || inside(row.directory, value)) ||
                snapshot.some(
                  (record) =>
                    record !== current &&
                    record.result.serviceReceipts?.some(
                      (receipt) =>
                        receipt.services.some(
                          (service) =>
                            service.pid !== undefined &&
                            processes.pids.has(service.pid) &&
                            (head === record.result.oldCommit || head === record.result.newCommit),
                        ) ||
                        (receipt.runtime !== undefined &&
                          processes.pids.has(receipt.runtime.pid) &&
                          receipt.runtime.commit === head),
                    ),
                );
              if (live(await runtimeProcesses())) {
                keep("live_runtime_or_helper");
                continue;
              }
              const after = await observeLocalProjectGitWorktree(root, path);
              if (
                !isDeepStrictEqual(before, after) ||
                (await checkoutGit(path, ["rev-parse", "HEAD"])).trim() !== head ||
                (await checkoutGit(path, ["status", "--porcelain", "--untracked-files=all"]))
              )
                throw Error("runtime_worktree_changed");
              if (live(await runtimeProcesses())) {
                keep("live_runtime_or_helper");
                continue;
              }
              if (!isDeepStrictEqual([...(await input.protectedUpdateIds())].sort(), held))
                throw Error("runtime_retention_canary_holds_changed");
              guard();
              writePrivateJson(pendingPath, { path, head, operation: row.result.id });
              const pendingFd = openSync(pendingPath, constants.O_RDONLY | constants.O_NOFOLLOW);
              try {
                fsyncSync(pendingFd);
              } finally {
                closeSync(pendingFd);
              }
              const directoryFd = openSync(updates, constants.O_RDONLY);
              try {
                fsyncSync(directoryFd);
              } finally {
                closeSync(directoryFd);
              }
              audit({ event: "removing", path, head, operation: row.result.id });
              // No --force, no recursive namespace deletion, no journal removal.
              await checkoutGit(input.checkout, ["worktree", "remove", path]);
              if (
                existsSync(path) ||
                (await checkoutGit(input.checkout, ["worktree", "list", "--porcelain", "-z"]))
                  .split("\0")
                  .includes(`worktree ${path}`)
              )
                throw Error("runtime_retention_effect_unconfirmed");
              removed.push(path);
              audit({ event: "removed", path, head });
              unlinkSync(pendingPath);
            } catch (error) {
              keep(errorText(error));
              if (existsSync(pendingPath)) throw Error("runtime_retention_effect_unconfirmed");
            }
          }
        const result = report();
        writePrivateJson(join(updates, "retention.json"), result);
        return result;
      } catch (error) {
        const result = report(error instanceof Error ? error.message : "runtime_retention_unverified");
        writePrivateJson(join(updates, "retention.json"), result);
        return result;
      }
    });
  } catch (error) {
    return report(error instanceof Error ? error.message : "runtime_retention_locked");
  }
}
