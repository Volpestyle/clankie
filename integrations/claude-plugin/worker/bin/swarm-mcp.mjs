#!/usr/bin/env node
// The clankie-worker plugin's one MCP server, in one of two launches.
//
// A Swarm-dispatched interactive worker (ADR 0194): run the Swarm MCP the
// trusted Herdr launcher named in SWARM_WORKER_MCP, in channel mode, with the
// worker's own enrolled capability from the launch environment. It reads
// nothing else: no operator broker, no Clankie bearer, no config file.
//
// A seat Clankie hired into a herdr pane (VUH-1458): serve that seat's mailbox
// as this plugin's channel through `clankie mcp --seat`, which polls only when
// the Claude session that launched this server actually loaded the channel.
// On a machine linked to his fleet (VUH-1527) the same channel, and a
// message_clankie tool, run here over that machine's link.
import { execFileSync, spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { hasLinks, parentCommandLine } from "./link.mjs";
import { runSeatChannel } from "./seat-channel.mjs";

const fail = (message) => {
  process.stderr.write(`clankie-worker: ${message}\n`);
  process.exit(1);
};
const run = (command, args, env) => {
  const child = spawn(command, args, { stdio: "inherit", env });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => fail(error.message));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
};

if (process.env.SWARM_WORKER_LAUNCH) {
  let argv;
  try {
    argv = JSON.parse(process.env.SWARM_WORKER_MCP ?? "null");
  } catch {
    argv = null;
  }
  if (process.env.SWARM_MCP_CHANNEL !== "1")
    fail("only a Swarm-dispatched interactive worker launch runs this server");
  if (
    !Array.isArray(argv) ||
    argv.length !== 2 ||
    !argv.every((part) => typeof part === "string" && isAbsolute(part))
  )
    fail("SWARM_WORKER_MCP must name the absolute Node and Swarm MCP paths");
  run(argv[0], [argv[1]], process.env);
} else if (hasLinks()) {
  // A machine in one of his ssh fleets (VUH-1527) reaches him through its link,
  // with no `clankie` CLI or operator credential here.
  runSeatChannel({ paneId: process.env.HERDR_PANE_ID?.trim(), parentArgv: parentCommandLine() });
} else {
  if (!process.env.HERDR_PANE_ID)
    fail("only a Clankie hire in a herdr pane or a Swarm worker runs this server");
  // The bridge checks its parent's argv for the channel; its parent is this
  // wrapper, so hand it Claude's.
  let parent = "";
  try {
    parent = execFileSync("ps", ["-o", "args=", "-p", String(process.ppid)], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
  } catch {
    parent = "";
  }
  run("clankie", ["mcp", "--seat"], { ...process.env, CLANKIE_SEAT_PARENT_ARGV: parent });
}
