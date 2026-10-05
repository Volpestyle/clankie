// Explicitly trusted fixture launcher, not a claim to be an installed Codex TUI.
// Real Herdr hooks + a real foreground process + its actual TCP child are used.
import { execFileSync, spawn } from "node:child_process";
const [control, clientScript, name, endpoint, pane, socketPath, session] = process.argv.slice(2);
const env = { ...process.env, HERDR_SOCKET_PATH: socketPath };
execFileSync(
  "herdr",
  [
    "pane",
    "report-agent",
    pane,
    "--source",
    "project-proof-fixture",
    "--agent",
    "codex",
    "--state",
    "idle",
    "--agent-session-id",
    session,
  ],
  { env, stdio: "ignore" },
);
const child = spawn(process.execPath, [clientScript, control, name, endpoint, pane], {
  env,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 1));
process.on("SIGTERM", () => child.kill());
process.on("SIGHUP", () => child.kill());
