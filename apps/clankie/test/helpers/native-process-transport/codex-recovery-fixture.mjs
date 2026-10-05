// Ordinary Node executable fixture. It is not Codex, a model, or a harness TUI.
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { WebSocketServer } from "ws";

const [mode, statePath, controlPath, pane, herdrSocket] = process.argv.slice(2);
if (mode === "server") {
  const initial = JSON.parse(readFileSync(statePath, "utf8"));
  const http = createServer();
  const ws = new WebSocketServer({ server: http });
  ws.on("connection", (socket) =>
    socket.on("message", (bytes) => {
      const request = JSON.parse(String(bytes));
      appendFileSync(initial.journal, JSON.stringify({ method: request.method }) + "\n");
      if (request.id === undefined) return;
      const current = JSON.parse(readFileSync(statePath, "utf8"));
      const result =
        request.method === "thread/loaded/list"
          ? { data: [current.thread], nextCursor: null }
          : request.method === "thread/read"
            ? { thread: { id: request.params.threadId, parentThreadId: null } }
            : {};
      socket.send(JSON.stringify({ id: request.id, result }));
    }),
  );
  http.listen(initial.nativeSocket, () =>
    process.stdout.write(JSON.stringify({ ready: true, pid: process.pid }) + "\n"),
  );
} else if (mode === "foreground") {
  execFileSync(
    "herdr",
    [
      "pane",
      "report-agent",
      pane,
      "--source",
      "native-recovery-fixture",
      "--agent",
      "codex",
      "--state",
      "idle",
    ],
    {
      env: { ...process.env, HERDR_SOCKET_PATH: herdrSocket },
      stdio: "ignore",
    },
  );
  const control = connect(controlPath);
  let duplicate;
  process.on("exit", () => duplicate?.kill());
  control.on("connect", () =>
    control.write(JSON.stringify({ ready: "recovery-foreground", pid: process.pid }) + "\n"),
  );
  control.on("error", () => process.exit(1));
  control.on("close", () => process.exit(0));
  createInterface({ input: control }).on("line", async (line) => {
    const command = JSON.parse(line);
    if (command.quit) {
      control.end();
      return;
    }
    if (command.action === "share") {
      duplicate = spawn(process.execPath, [process.argv[1], "duplicate"], { stdio: "ignore" });
      await once(duplicate, "spawn");
    } else if (command.action === "release" && duplicate) {
      const closed = once(duplicate, "close");
      duplicate.kill();
      await closed;
      duplicate = undefined;
    }
    control.write(
      JSON.stringify({ id: command.id, status: 200, effects: 0, port: 0, coOwnerPid: duplicate?.pid }) + "\n",
    );
  });
} else if (mode === "duplicate") {
  setInterval(() => {}, 1_000);
} else throw new Error("Unknown fixture mode");
