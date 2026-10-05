// Ordinary pane process: a persistent real HTTP client controlled by the test's
// private Unix socket. No credentials, native agent, or caller PID assertion.
import { connect } from "node:net";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { Agent, request } from "node:http";
import { createInterface } from "node:readline";

const [controlPath, name, endpoint, defaultPane] = process.argv.slice(2);
const control = connect(controlPath);
const agent = new Agent({ keepAlive: true, maxSockets: 1 });
let holder;
control.on("connect", () => control.write(JSON.stringify({ ready: name, pid: process.pid }) + "\n"));
control.on("error", () => process.exit(1));
control.on("close", () => {
  holder?.kill();
  agent.destroy();
  process.exit(0);
});
for await (const line of createInterface({ input: control })) {
  const command = JSON.parse(line);
  if (command.quit) {
    holder?.kill();
    agent.destroy();
    control.end();
    break;
  }
  try {
    if (command.action === "share") {
      if (holder) throw new Error("Socket already shared");
      const socket = Object.values(agent.freeSockets)
        .flat()
        .find((value) => !value.destroyed);
      if (!socket) throw new Error("No live idle HTTP socket to share");
      const fd = socket._handle?.fd;
      if (!Number.isSafeInteger(fd) || fd < 0) throw new Error("Missing native socket descriptor");
      holder = spawn(process.execPath, [fileURLToPath(new URL("./socket-holder.mjs", import.meta.url))], {
        stdio: ["ignore", "ignore", "ignore", fd, "ipc"],
      });
      const [ready] = await once(holder, "message");
      if (!ready.ready) throw new Error("Socket holder did not start");
      control.write(JSON.stringify({ id: command.id, status: 200, coOwnerPid: ready.pid }) + "\n");
      continue;
    }
    if (command.action === "release") {
      if (!holder) throw new Error("Socket is not shared");
      const exited = once(holder, "exit");
      holder.kill();
      await exited;
      holder = undefined;
      control.write(JSON.stringify({ id: command.id, status: 200 }) + "\n");
      continue;
    }
    const result = await new Promise((resolve, reject) => {
      const req = request(
        endpoint,
        {
          agent,
          headers: { "x-clankie-pane": command.pane ?? defaultPane },
        },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () => resolve({ status: response.statusCode, ...JSON.parse(body) }));
        },
      );
      req.on("error", reject);
      req.setTimeout(5_000, () => req.destroy(new Error("Fixture request timed out")));
      req.end();
    });
    control.write(JSON.stringify({ id: command.id, ...result }) + "\n");
  } catch (error) {
    control.write(JSON.stringify({ id: command.id, error: String(error) }) + "\n");
  }
}
