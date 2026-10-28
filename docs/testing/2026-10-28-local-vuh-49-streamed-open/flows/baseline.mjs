// One generated case per size; 180 days is never regenerated or repeated as a benchmark.
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
const root = resolve(".local/vuh49/baseline");
mkdirSync(join(root, "home"), { recursive: true });
const env = {
  PATH: process.env.PATH,
  HOME: join(root, "home"),
  NODE_ENV: "test",
  XDG_CONFIG_HOME: join(root, "home/.config"),
  XDG_STATE_HOME: join(root, "home/.state"),
  XDG_DATA_HOME: join(root, "home/.data"),
};
const run = (file, args, timeout = 180000) => {
  const r = spawnSync(process.execPath, ["--max-old-space-size=8192", file, ...args], {
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: 1 << 20,
  });
  const result = {
    status: r.status,
    signal: r.signal,
    error: r.error?.message,
    stdout: r.stdout,
    stderr: r.stderr,
  };
  console.log(JSON.stringify({ file, args, ...result }));
  return result;
};
const flows = "docs/testing/2026-10-28-local-vuh-49-streamed-open/flows/";
const template = run(flows + "template.ts", [root]);
if (template.status !== 0) process.exit(1);
const results = [];
for (const days of [60, 90, 180]) {
  const directory = join(root, String(days));
  const generated = run("docs/testing/2026-10-27-local-vuh-42-tracker-journal/flows/generate-store.ts", [
    "--template",
    join(root, "template.json"),
    "--days",
    String(days),
    "--out",
    directory,
    "--checkpoint",
  ]);
  if (generated.status !== 0) process.exit(1);
  const opened = run(flows + "open.ts", [directory], 60000);
  results.push({ days, generated, opened });
  writeFileSync(
    join(root, "baseline.json"),
    JSON.stringify({ mix: JSON.parse(readFileSync(join(root, "mix.json"))), results }, null, 2),
  );
}
