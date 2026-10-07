import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { buildFleetProof } from "./build-fleet-proof.mjs";

// Keep the checkout's ordinary startup preparation outside the CPU profile.
const directory = process.argv[2];
if (!directory) throw new Error("CPU profile output directory is required");
await buildFleetProof();
const app = resolve(import.meta.dirname, "../apps/clankie");
const require = createRequire(join(app, "package.json"));
const child = spawn(
  process.execPath,
  [
    "--cpu-prof",
    `--cpu-prof-dir=${directory}`,
    "--import",
    require.resolve("tsx"),
    join(app, "src/index.ts"),
  ],
  { cwd: app, env: process.env, stdio: "inherit" },
);
// The supervisor signals the entire group. Retain this controller until Node
// finishes its graceful shutdown and writes the profile; also support a signal
// addressed directly to this controller.
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal === "SIGINT" ? 130 : 143);
});
