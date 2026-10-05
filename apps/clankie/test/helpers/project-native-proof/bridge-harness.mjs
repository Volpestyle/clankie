// Ordinary foreground fixture; drives the shipped stdio bridge, never a hired agent.
import { spawn } from "node:child_process";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
const [controlPath, bridgeScript, state, name, pane, socketPath, logPath] = process.argv.slice(2);
const env = {
  ...process.env,
  CLANKIE_STATE: state,
  HERDR_SOCKET_PATH: socketPath,
  HERDR_PANE_ID: pane,
  CLANKIE_SEAT_PARENT_ARGV: "ordinary-fixture --channels plugin:clankie-worker@clankie",
};
for (const key of Object.keys(env)) if (/TOKEN|SECRET|CREDENTIAL|API_KEY/u.test(key)) delete env[key];
let bridge;
let ready = false;
let tools;
const record = (kind, data) => appendFileSync(logPath, JSON.stringify({ at: Date.now(), kind, data }) + "\n");
const send = (message) => bridge.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const control = connect(controlPath);
control.on("connect", () => control.write(JSON.stringify({ ready: name, pid: process.pid }) + "\n"));
control.on("error", () => {
  bridge?.kill();
  if (!bridge) process.exit(0);
});
control.on("close", () => {
  bridge?.kill();
  if (!bridge) process.exit(0);
});
createInterface({ input: control }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.quit) {
    bridge?.kill();
    if (!bridge) process.exit(0);
    return;
  }
  if (command.action === "share" && !bridge) start();
  control.write(
    JSON.stringify({
      id: command.id,
      status: 200,
      port: 0,
      effects: 0,
      catalogReady: ready,
      bridgePid: bridge?.pid,
      harnessPid: process.pid,
      tools,
    }) + "\n",
  );
});
function start() {
  bridge = spawn(process.execPath, [bridgeScript], { env, stdio: ["pipe", "pipe", "pipe"] });
  createInterface({ input: bridge.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    record("stdout", message);
    if (message.id === 1 && message.result) {
      send({ method: "notifications/initialized" });
      send({ id: 2, method: "tools/list", params: {} });
    }
    if (message.id === 2 && message.result) {
      ready = true;
      tools = message.result.tools.map((tool) => tool.name);
    }
  });
  createInterface({ input: bridge.stderr }).on("line", (line) => record("stderr", line));
  bridge.on("error", (error) => record("error", String(error)));
  bridge.on("exit", (code, signal) => {
    record("exit", { code, signal });
    control.destroy();
    process.exit(code ?? 0);
  });
  process.on("SIGTERM", () => {
    bridge?.kill();
    if (!bridge) process.exit(0);
  });
  process.on("SIGHUP", () => {
    bridge?.kill();
    if (!bridge) process.exit(0);
  });
  send({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "ordinary-benchmark-driver", version: "1" },
    },
  });
}
