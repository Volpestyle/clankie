#!/usr/bin/env node
// Run one CI command under a heavy permit from the machine owner's Clankie
// (#562): the CI account connects to the owner-enabled permit socket, waits
// its turn with the fleet's own builds, runs the command once granted and
// stops it if the permit is lost. No dependencies; runs before install.
//
//   node scripts/ci-heavy.mjs [--socket PATH] [--label NAME] -- COMMAND ARGS...
//
// When the socket is missing, the service is down or it refuses, the command
// runs ungoverned with a warning, as it does where Clankie is not installed.
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { constants } from "node:os";

const DEFAULT_SOCKET = "/Users/Shared/clankie-permits/heavy.sock";

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
const flags = split === -1 ? [] : argv.slice(0, split);
const command = split === -1 ? argv : argv.slice(split + 1);
let socketPath = DEFAULT_SOCKET;
let label = "ci";
for (let index = 0; index < flags.length; index += 2) {
  const value = flags[index + 1];
  if (value === undefined) usage();
  if (flags[index] === "--socket") socketPath = value;
  else if (flags[index] === "--label") label = value;
  else usage();
}
if (command.length === 0) usage();

function usage() {
  process.stderr.write(
    "Usage: node scripts/ci-heavy.mjs [--socket PATH] [--label NAME] -- COMMAND ARGS...\n",
  );
  process.exit(2);
}

const warn = (message) => process.stderr.write(`::warning::${message}\n`);
const note = (message) => process.stderr.write(`[ci-heavy] ${message}\n`);

let child;
let granted = false;
let lost = false;
let killTimer;

function runChild() {
  // Its own process group, so a lost permit stops everything it started.
  child = spawn(command[0], command.slice(1), { stdio: "inherit", detached: true });
  child.once("error", (error) => {
    process.stderr.write(`[ci-heavy] ${command[0]}: ${error.message}\n`);
    finish(127);
  });
  child.once("exit", (code, signal) => finish(lost ? 1 : (code ?? 128 + (constants.signals[signal] ?? 1))));
}

function stopChild(signal = "SIGTERM") {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
}

function finish(code) {
  if (killTimer) clearTimeout(killTimer);
  socket.destroy();
  process.exit(code);
}

function ungoverned(reason) {
  if (child) return;
  warn(`Running without a heavy permit: ${reason}`);
  socket.destroy();
  runChild();
}

for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    if (!child) finish(signal === "SIGINT" ? 130 : 143);
    stopChild(signal);
  });

const socket = connect(socketPath);
let buffer = "";
const seen = new Set();
socket.setEncoding("utf8");
socket.once("connect", () => {
  socket.write(`${JSON.stringify({ op: "acquire", lane: "full", label })}\n`);
});
socket.on("data", (chunk) => {
  buffer = (buffer + chunk).slice(-4096);
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    handle(message);
  }
});
socket.on("error", (error) => {
  if (!granted) ungoverned(`permit socket unavailable (${error.code ?? error.message})`);
});
socket.once("close", () => {
  if (granted) loseLease("the permit connection closed");
  else ungoverned("the permit socket closed before a grant");
});

function handle(message) {
  if (message.state === "waiting") {
    const reason = String(message.reason ?? "queued");
    if (!seen.has(reason)) note(`waiting for a heavy permit (${reason})`);
    seen.add(reason);
  } else if (message.state === "granted" && !granted && !child) {
    granted = true;
    note("heavy permit granted");
    runChild();
  } else if (message.state === "refused" && !granted) {
    ungoverned(`the permit socket refused (${String(message.reason ?? "unknown")})`);
  } else if (message.state === "lost") {
    loseLease(`permit lost (${String(message.reason ?? "unknown")})`);
  }
}

function loseLease(reason) {
  if (lost || !child) return;
  lost = true;
  process.stderr.write(`::error::Heavy ${reason}; stopping the command\n`);
  stopChild("SIGTERM");
  killTimer = setTimeout(() => stopChild("SIGKILL"), 5_000);
}
