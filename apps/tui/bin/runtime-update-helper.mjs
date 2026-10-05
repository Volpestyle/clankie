/** Fixed detached helper copied with its builtin-only modules before acceptance. */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  openSync,
  closeSync,
  lstatSync,
  readFileSync,
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
const expected = ["runtime-update-helper.mjs", "runtime-update.ts", "pinned-runtime.ts", "update-files.ts"];
if (Object.keys(files).length !== expected.length) throw Error("Unknown helper manifest");
for (const name of expected) {
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
const { executeRuntimeUpdate, parseServiceReceipt, readRuntimeUpdate } = await import("./runtime-update.ts");
const data = object(readPrivateJson(join(directory, "plan.json")));
if (
  Object.keys(data).sort().join(",") !==
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
  active.id !== plan.id ||
  accepted.id !== plan.id ||
  accepted.phase !== "scheduled" ||
  accepted.oldCommit !== plan.oldCommit ||
  accepted.newCommit !== plan.newCommit
)
  throw Error("Update is not accepted for execution");
// A copied helper is one-shot even if invoked twice. A crash requires reconciliation, never replay.
closeSync(openSync(join(directory, "claimed"), "wx", 0o600));
const exec = promisify(execFile);
const cli = async (runtime, args) => {
  const { stdout } = await exec(process.execPath, [join(runtime, "apps/tui/bin/clankie.ts"), ...args], {
    cwd: runtime,
    env: process.env,
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
  services: async (runtime, action) => {
    let outcome;
    try {
      outcome = await cli(runtime, [action, "all"]);
    } catch (error) {
      // Nonzero supervisor exits may still carry exact per-service failure receipts.
      if (typeof error?.stdout !== "string") throw Error("Service result unavailable");
      outcome = JSON.parse(error.stdout);
    }
    const receipt = parseServiceReceipt(outcome);
    if (action === "down" || !receipt.ok) return receipt;
    const status = object(await cli(runtime, ["update", "status"]));
    return parseServiceReceipt({ ...receipt, runtime: status.runtime });
  },
});
process.stdout.write(JSON.stringify(result) + "\n");
process.exitCode = result.phase === "healthy" && result.harnessRefresh?.ok !== false ? 0 : 1;
