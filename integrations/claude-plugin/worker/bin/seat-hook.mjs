#!/usr/bin/env node
// The clankie-worker plugin's lifecycle hook (VUH-1458). A seat Clankie hired
// into a herdr pane reports each settled turn through `clankie seat-hook`; a
// Swarm worker, or any session outside a pane, has nothing to report here.
import { spawn } from "node:child_process";

if (process.env.SWARM_WORKER_LAUNCH || !process.env.HERDR_PANE_ID) process.exit(0);
const child = spawn("clankie", ["seat-hook"], { stdio: ["pipe", "inherit", "inherit"], env: process.env });
process.stdin.pipe(child.stdin);
child.on("error", (error) => {
  process.stderr.write(`clankie-worker: ${error.message}\n`);
  process.exit(0);
});
child.on("exit", (code) => process.exit(code ?? 0));
