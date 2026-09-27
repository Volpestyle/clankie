#!/usr/bin/env node
// The clankie-worker plugin's one MCP server (ADR 0194). It runs the Swarm MCP
// that the trusted Herdr launcher named in SWARM_WORKER_MCP, in channel mode,
// with the worker's own enrolled capability from the launch environment. It
// reads nothing else: no operator broker, no Clankie bearer, no config file.
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

const fail = (message) => {
  process.stderr.write(`clankie-worker: ${message}\n`);
  process.exit(1);
};
let argv;
try {
  argv = JSON.parse(process.env.SWARM_WORKER_MCP ?? "null");
} catch {
  argv = null;
}
// Enabled outside a Swarm-dispatched interactive launch, there is nothing to serve.
if (process.env.SWARM_MCP_CHANNEL !== "1" || !process.env.SWARM_WORKER_LAUNCH)
  fail("only a Swarm-dispatched interactive worker launch runs this server");
if (
  !Array.isArray(argv) ||
  argv.length !== 2 ||
  !argv.every((part) => typeof part === "string" && isAbsolute(part))
)
  fail("SWARM_WORKER_MCP must name the absolute Node and Swarm MCP paths");
const child = spawn(argv[0], [argv[1]], { stdio: "inherit", env: process.env });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => fail(error.message));
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
