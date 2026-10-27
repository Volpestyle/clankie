// Run ONLY inside `clankie heavy --server -- node .../run.mjs APP_CHECKOUT SCRATCH_SEED OUT`.
// The governor retains its normal environment; the proof child receives no owner state.
import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const [app, seed, output] = process.argv.slice(2).map((value) => resolve(value));
if (!app || !seed || !output) throw new Error("APP_CHECKOUT SCRATCH_SEED OUT required");
await mkdir(resolve(".local"), { recursive: true });
const root = await mkdtemp(resolve(".local/peak-day-"));
const env = {
  PATH: process.env.PATH,
  NODE_ENV: "test",
  HOME: join(root, "home"),
  CLANKIE_STATE: join(root, "state"),
};
env.NODE_OPTIONS = "--max-old-space-size=8192";
for (const kind of ["CONFIG", "STATE", "DATA", "CACHE"])
  env[`XDG_${kind}_HOME`] = join(root, kind.toLowerCase());
env.XDG_RUNTIME_DIR = join(root, "runtime");
for (const path of Object.values(env).filter((value) => value?.startsWith(root)))
  await mkdir(path, { recursive: true });
await mkdir(output, { recursive: true });
let source = seed;
if ((await stat(seed)).isFile()) {
  source = join(root, "generated-60d");
  const generated = spawnSync(
    process.execPath,
    [
      resolve("docs/testing/2026-10-27-local-vuh-42-tracker-journal/flows/generate-store.ts"),
      "--template",
      seed,
      "--days",
      "60",
      "--out",
      source,
    ],
    { env, stdio: "inherit" },
  );
  if (generated.status !== 0) process.exit(generated.status ?? 1);
}
const child = spawn(
  resolve("apps/clankie/node_modules/.bin/tsx"),
  [resolve("scripts/manual/tracker-peak-day.ts"), app, source, output, root],
  { env, stdio: "inherit" },
);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
