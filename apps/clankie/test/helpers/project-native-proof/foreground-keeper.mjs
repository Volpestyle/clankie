// Ordinary foreground process for the trusted launcher seam, not a Codex TUI.
import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import { createInterface } from "node:readline";
const [controlPath, name, pane, socketPath, thread] = process.argv.slice(2);
execFileSync(
  "herdr",
  [
    "pane",
    "report-agent",
    pane,
    "--source",
    "project-proof-frequency-fixture",
    "--agent",
    "codex",
    "--state",
    "idle",
  ],
  { env: { ...process.env, HERDR_SOCKET_PATH: socketPath }, stdio: "ignore" },
);
execFileSync(
  "herdr",
  [
    "pane",
    "report-agent",
    pane,
    "--source",
    "herdr:codex",
    "--agent",
    "codex",
    "--state",
    "idle",
    "--agent-session-id",
    thread,
  ],
  { env: { ...process.env, HERDR_SOCKET_PATH: socketPath }, stdio: "ignore" },
);
const control = connect(controlPath);
control.on("connect", () => control.write(JSON.stringify({ ready: name, pid: process.pid }) + "\n"));
control.on("error", () => process.exit(1));
control.on("close", () => process.exit(0));
createInterface({ input: control }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.quit) {
    control.end();
    return;
  }
  control.write(JSON.stringify({ id: command.id, status: 200, port: 0, effects: 0, ready: true }) + "\n");
});
