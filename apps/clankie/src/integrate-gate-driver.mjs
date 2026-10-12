// Runs one batch's install and gate commands inside one governed process group.
// The service sends its plan through stdin; only phase receipts reach stdout.
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { open } from "node:fs/promises";
const plan = JSON.parse(readFileSync(0, "utf8"));
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
emit({ type: "ready", pid: process.pid });
for (const phase of plan.phases) {
  const startedAt = new Date().toISOString();
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: phase.directory, encoding: "utf8" }).trim();
  emit({ type: "begin", repo: phase.repo, phase: phase.name });
  const out = createWriteStream(phase.log, { flags: "wx", mode: 0o600 });
  const result = await new Promise((resolve, reject) => {
    out.on("error", reject);
    const env = { ...phase.env };
    // The native supervisor's permit and fan-out caps must reach every phase.
    for (const key of [
      "CLANKIE_RESOURCE_DIRECTORY",
      "CLANKIE_RESOURCE_LEASE",
      "VITEST_MAX_WORKERS",
      "TURBO_CONCURRENCY",
    ])
      if (process.env[key] !== undefined) env[key] = process.env[key];
    const child = spawn("pnpm", phase.args, { cwd: phase.directory, env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => out.end(() => resolve({ exitCode, signal })));
  });
  const file = await open(phase.log, "r");
  try {
    await file.sync();
  } finally {
    await file.close();
  }
  emit({
    type: "end",
    repo: phase.repo,
    phase: phase.name,
    record: { head, ...result, startedAt, finishedAt: new Date().toISOString(), log: phase.log },
  });
  if (result.exitCode !== 0) {
    process.exitCode ??= result.exitCode ?? 1;
    if (phase.name === "install") break;
  }
}
