/** Detached release-update helper. It runs from the old release, which stays in place throughout. */
import { execFile } from "node:child_process";
import { closeSync, openSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { launchMacApp } from "./mac-app.ts";
import { executeReleaseUpdate, parseReleasePlan } from "./release-update.ts";
import { readRuntimeUpdate, runtimeUpdateServices } from "./runtime-update.ts";
import { object, operationId, readPrivateJson } from "./update-files.ts";

const directory = realpathSync(process.argv[2] ?? "");
const plan = parseReleasePlan(readPrivateJson(join(directory, "plan.json")));
const updates = join(plan.home, ".clankie", "updates");
if (plan.directory !== directory || basename(directory) !== plan.id || dirname(directory) !== updates)
  throw Error("Update path binding changed");
const active = operationId(object(readPrivateJson(join(updates, "active", "operation.json"))).id);
const accepted = readRuntimeUpdate(directory);
if (
  active !== plan.id ||
  accepted.id !== plan.id ||
  accepted.phase !== "scheduled" ||
  accepted.oldCommit !== plan.oldCommit ||
  accepted.newCommit !== plan.newCommit
)
  throw Error("Update is not accepted for execution");
// One-shot even if invoked twice. A crash requires reconciliation, never replay.
closeSync(openSync(join(directory, "claimed"), "wx", 0o600));

const exec = promisify(execFile);
// Each release's own launcher resolves its root from its real path.
const cli = async (release: string, args: readonly string[]): Promise<unknown> => {
  const { stdout } = await exec(join(release, "bin", "clankie"), [...args], {
    cwd: release,
    // Owner restarts wait while this operation's helper runs; its own calls pass.
    env: { ...process.env, CLANKIE_UPDATE_OPERATION: plan.id },
    timeout: args[0] === "harness" ? 20 * 60_000 : 300_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(stdout);
};
const result = await executeReleaseUpdate(plan, {
  applicationsDirectory: process.env.CLANKIE_APPLICATIONS_DIR,
  launchApp: async (release, path) => {
    const paired = await launchMacApp(release, path, { ...process.env, CLANKIE_UPDATE_OPERATION: plan.id });
    writeFileSync(join(directory, "app-handoff.json"), JSON.stringify({ paired }) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
  },
  services: (release, action) => runtimeUpdateServices(release, action, cli),
  refreshHarnesses: async (release) => {
    let refreshed: unknown;
    try {
      refreshed = await cli(release, ["harness", "install", "--refresh-linked"]);
    } catch (error) {
      const stdout = (error as { stdout?: unknown }).stdout;
      if (typeof stdout !== "string") throw error;
      refreshed = JSON.parse(stdout);
    }
    const receipt = join(directory, "harness-refresh.json");
    writeFileSync(receipt, `${JSON.stringify(refreshed)}\n`, { mode: 0o600, flag: "wx" });
    return { ok: object(refreshed).ok === true, receipt };
  },
});
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.phase === "healthy" && result.harnessRefresh?.ok !== false ? 0 : 1;
