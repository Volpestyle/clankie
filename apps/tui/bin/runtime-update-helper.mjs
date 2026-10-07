/** Fixed detached helper copied with its builtin-only modules before acceptance. */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  openSync,
  closeSync,
  lstatSync,
  readFileSync,
  renameSync,
  writeFileSync,
  realpathSync,
  constants,
  fstatSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
const directory = realpathSync(import.meta.dirname);
const dirStat = lstatSync(directory);
if (
  !dirStat.isDirectory() ||
  (dirStat.mode & 0o077) !== 0 ||
  (process.getuid && dirStat.uid !== process.getuid())
)
  throw Error("Invalid helper directory");
// The copies run outside any workspace, so they import only `node:` builtins and each other.
const HELPER_FILES = [
  "runtime-update-helper.mjs",
  "runtime-update.ts",
  "pinned-runtime.ts",
  "update-files.ts",
];
// A copied helper is one-shot even if invoked twice. A crash requires reconciliation, never replay.
const claim = () => closeSync(openSync(join(directory, "claimed"), "wx", 0o600));

/** Verify the copies and the accepted plan, then claim the operation. Nothing here has effects. */
async function prepare() {
  const fd = openSync(join(directory, "helper.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
  let files;
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 32768 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw Error("Invalid helper manifest");
    files = JSON.parse(readFileSync(fd, "utf8")).files;
  } finally {
    closeSync(fd);
  }
  if (!files || typeof files !== "object" || Array.isArray(files)) throw Error("Invalid helper manifest");
  if (Object.keys(files).length !== HELPER_FILES.length) throw Error("Unknown helper manifest");
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
      throw Error("Helper source changed");
  }
  const { readPrivateJson, object, boundedString, commitString, operationId } =
    await import("./update-files.ts");
  const { installCommand } = await import("./pinned-runtime.ts");
  const {
    executeRuntimeUpdate,
    runtimeUpdateServices,
    readRuntimeUpdate,
    parseUpdateInitiator,
    parseCheckoutSyncResult,
  } = await import("./runtime-update.ts");
  const data = object(readPrivateJson(join(directory, "plan.json")));
  const optional = ["resolvedRef", "warning", "initiator", "ownerCheckoutSync"];
  if (
    Object.keys(data)
      .filter((key) => !optional.includes(key))
      .sort()
      .join(",") !==
    ["id", "ref", "checkout", "runtime", "home", "directory", "oldCommit", "newCommit", "oldInstanceId"]
      .sort()
      .join(",")
  )
    throw Error("Invalid update plan fields");
  const plan = {
    id: operationId(data.id),
    ref: boundedString(data.ref, 256),
    checkout: boundedString(data.checkout, 4096),
    runtime: boundedString(data.runtime, 4096),
    home: boundedString(data.home, 4096),
    directory: boundedString(data.directory, 4096),
    oldCommit: commitString(data.oldCommit),
    newCommit: commitString(data.newCommit),
    oldInstanceId: operationId(data.oldInstanceId),
    ...(data.resolvedRef === undefined ? {} : { resolvedRef: boundedString(data.resolvedRef, 512) }),
    ...(data.ownerCheckoutSync === undefined
      ? {}
      : { ownerCheckoutSync: parseCheckoutSyncResult(data.ownerCheckoutSync) }),
    ...(data.warning === undefined ? {} : { warning: data.warning }),
    ...(data.initiator === undefined ? {} : { initiator: parseUpdateInitiator(data.initiator) }),
  };
  if (
    plan.directory !== directory ||
    plan.id !== basename(directory) ||
    dirname(directory) !== join(plan.home, ".clankie", "updates") ||
    plan.runtime !== resolve(process.env.CLANKIE_RUNTIME_DIR || join(plan.home, ".clankie", "pinned"))
  )
    throw Error("Update path binding changed");
  const active = object(readPrivateJson(join(dirname(directory), "active", "operation.json")));
  const accepted = readRuntimeUpdate(directory);
  if (
    ![undefined, "older-than-current-pin", "diverged-from-current-pin"].includes(plan.warning) ||
    active.id !== plan.id ||
    accepted.id !== plan.id ||
    accepted.phase !== "scheduled" ||
    accepted.oldCommit !== plan.oldCommit ||
    accepted.newCommit !== plan.newCommit ||
    accepted.resolvedRef !== plan.resolvedRef ||
    accepted.warning !== plan.warning ||
    JSON.stringify(accepted.initiator) !== JSON.stringify(plan.initiator)
  )
    throw Error("Update is not accepted for execution");
  claim();
  return { plan, installCommand, executeRuntimeUpdate, runtimeUpdateServices };
}

/**
 * A helper stopped before its claim changed nothing. Record that as a terminal pre-cutover failure,
 * with builtins only (the copied modules may be what failed), so the operation does not sit
 * `scheduled` holding the lock. The claim fences a second helper or the service's own retirement:
 * whoever takes it first writes the outcome, and a `scheduled` record is never overwritten twice.
 */
function recordUnstarted(failure) {
  try {
    claim();
  } catch {
    return;
  }
  const path = join(directory, "result.json");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let accepted;
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 32768 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      return;
    accepted = JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
  if (!accepted || accepted.id !== basename(directory) || accepted.phase !== "scheduled") return;
  const message = String(failure instanceof Error ? failure.message : failure).replaceAll("\0", "");
  const result = {
    ...accepted,
    phase: "failed",
    reason: "pre-cutover-failed",
    error: `Update helper did not start: ${message}`.slice(0, 1024),
    updatedAt: new Date().toISOString(),
  };
  const text = JSON.stringify(result) + "\n";
  if (Buffer.byteLength(text) > 32768) return;
  const temporary = join(directory, ".result.json.next");
  writeFileSync(temporary, text, { flag: "wx", mode: 0o600 });
  renameSync(temporary, path);
  // As after a run, the final result is the log's last line.
  process.stdout.write(text);
}

let prepared;
try {
  prepared = await prepare();
} catch (failure) {
  process.stderr.write(`${failure?.stack ?? failure}\n`);
  try {
    recordUnstarted(failure);
  } catch (error) {
    process.stderr.write(`Could not record the unstarted update: ${error?.stack ?? error}\n`);
  }
  process.exit(1);
}
const { plan, installCommand, executeRuntimeUpdate, runtimeUpdateServices } = prepared;
const exec = promisify(execFile);
const cli = async (runtime, args) => {
  const { stdout } = await exec(process.execPath, [join(runtime, "apps/tui/bin/clankie.ts"), ...args], {
    cwd: runtime,
    // Owner restarts wait while this operation's helper runs; its own calls pass.
    env: { ...process.env, CLANKIE_UPDATE_OPERATION: plan.id },
    timeout: args[0] === "harness" ? 20 * 60_000 : 300_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(stdout);
};
const result = await executeRuntimeUpdate(plan, {
  run: installCommand,
  refreshHarnesses: async (runtime) => {
    let result;
    try {
      result = await cli(runtime, ["harness", "install", "--refresh-linked"]);
    } catch (error) {
      if (typeof error?.stdout !== "string") throw error;
      result = JSON.parse(error.stdout);
    }
    // Keep complete per-profile/fleet evidence outside the bounded transaction record.
    const receipt = join(directory, "harness-refresh.json");
    writeFileSync(receipt, JSON.stringify(result) + "\n", { mode: 0o600, flag: "wx" });
    return { ok: result.ok === true, receipt };
  },
  services: (runtime, action) => runtimeUpdateServices(runtime, action, cli),
});
process.stdout.write(JSON.stringify(result) + "\n");
process.exitCode = result.phase === "healthy" && result.harnessRefresh?.ok !== false ? 0 : 1;
