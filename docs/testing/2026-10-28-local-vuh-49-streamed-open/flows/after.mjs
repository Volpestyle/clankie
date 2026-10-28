import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
const root = resolve(".local/vuh49/baseline");
const env = {
  PATH: process.env.PATH,
  HOME: join(root, "home"),
  NODE_ENV: "test",
  XDG_CONFIG_HOME: join(root, "home/.config"),
  XDG_STATE_HOME: join(root, "home/.state"),
};
const results = [];
for (const days of [60, 90, 180]) {
  const r = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=8192",
      "docs/testing/2026-10-28-local-vuh-49-streamed-open/flows/open.ts",
      join(root, String(days)),
      "--write",
      ...(days === 180 ? ["--seal"] : []),
    ],
    { env, encoding: "utf8", timeout: 60000, maxBuffer: 1 << 20 },
  );
  const result = {
    days,
    status: r.status,
    signal: r.signal,
    error: r.error?.message,
    stdout: r.stdout,
    stderr: r.stderr,
  };
  results.push(result);
  console.log(JSON.stringify(result));
  writeFileSync(join(root, "after.json"), JSON.stringify(results, null, 2));
  if (r.status !== 0) process.exit(1);
}
