#!/usr/bin/env node
// A seat Clankie hired into a herdr pane (VUH-1458): serve that seat's mailbox
// as this plugin's channel through `clankie mcp --seat`, which polls only when
// the Claude session that launched this server actually loaded the channel.
// On a machine linked to his fleet (VUH-1527) the same channel, and a
// message_clankie tool, run here over that machine's link.
import { execFileSync, spawn } from "node:child_process";
import { hasLinks, parentCommandLine, seatIdentity } from "./link.mjs";
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

if (process.env.CLANKIE_JOINED_SEAT_TOKEN && process.env.CLANKIE_JOINED_WORKER_SESSION) {
  // A worker Clankie hired on a joined machine (VUH-2607) reaches its home through
  // that machine's join channel, even when the machine is also in an ssh fleet.
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
} else if (hasLinks()) {
  // A machine in one of his ssh fleets (VUH-1527) reaches him through its link,
  // with no `clankie` CLI or operator credential here.
  runSeatChannel({ paneId: seatIdentity().pane, parentArgv: parentCommandLine() });
} else {
  if (!seatIdentity().pane) fail("only a Clankie hire in a herdr pane or a linked fleet runs this server");
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
