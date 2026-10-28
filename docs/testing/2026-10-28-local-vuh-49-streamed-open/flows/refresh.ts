// Manual r2 external-append probe: one generated ~125 MB checkpoint, no 180-day rerun.
import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { loadavg } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [mode, runtimeArg] = process.argv.slice(2);
if (!["before", "after"].includes(mode!)) throw Error("before|after and runtime index required");
const root = resolve(".local/vuh49/r2-refresh");
await mkdir(join(root, "home"), { recursive: true });
const env = {
  PATH: process.env.PATH,
  HOME: join(root, "home"),
  NODE_ENV: "test",
  XDG_CONFIG_HOME: join(root, "home/.config"),
  XDG_STATE_HOME: join(root, "home/.state"),
};
function run(script: string, args: string[], timeout = 120000) {
  const r = spawnSync(process.execPath, ["--max-old-space-size=8192", script, ...args], {
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 1 << 20,
  });
  if (r.status !== 0)
    throw Error(JSON.stringify({ script, status: r.status, error: r.error?.message, stderr: r.stderr }));
  console.log(JSON.stringify({ script, stdout: r.stdout }));
}
if (mode === "before") {
  run("docs/testing/2026-10-28-local-vuh-49-streamed-open/flows/template.ts", [root]);
  run("docs/testing/2026-10-27-local-vuh-42-tracker-journal/flows/generate-store.ts", [
    "--template",
    join(root, "template.json"),
    "--days",
    "25",
    "--out",
    join(root, "seed"),
    "--checkpoint",
  ]);
  for (const label of ["before", "after"])
    await cp(join(root, "seed"), join(root, label), { recursive: true });
}
const runtime = pathToFileURL(resolve(runtimeArg!)).href;
const { createLocalTracker } = await import(runtime);
const directory = join(root, mode!);
const tracker = createLocalTracker({ directory });
const first = await tracker.call("list_issues", { limit: 1 });
const id = first.issues[0].id;
const samples = [];
for (let i = 0; i < 3; i++) {
  const child = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=8192",
      "--input-type=module",
      "-e",
      `
  const {createLocalTracker}=await import(${JSON.stringify(runtime)});
  await createLocalTracker({directory:${JSON.stringify(directory)}}).call('save_comment',{issueId:${JSON.stringify(id)},body:'external append ${i}'});
 `,
    ],
    { env, encoding: "utf8", timeout: 30000, maxBuffer: 1 << 20 },
  );
  if (child.status !== 0) throw Error(JSON.stringify({ error: child.error?.message, stderr: child.stderr }));
  const load = loadavg();
  const start = performance.now();
  const issue = await tracker.call("get_issue", { id });
  if (issue.id !== id) throw Error("Wrong issue");
  samples.push({ ms: performance.now() - start, load });
}
const file = join(directory, "tracker.json");
const report = {
  mode,
  runtime,
  checkpointBytes: (await stat(file)).size,
  checkpointSha256: createHash("sha256")
    .update(await readFile(file))
    .digest("hex"),
  samples,
  node: process.version,
};
await writeFile(join(root, mode + ".json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
