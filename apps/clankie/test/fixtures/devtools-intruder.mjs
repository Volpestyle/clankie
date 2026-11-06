// #245: another process of the owner's user trying to reach Clankie's private
// Chrome directly, as a hired worker's shell could. Given the profile directory
// and endpoints it found, it connects at once, then on "go" keeps trying every
// direct way in and reads the sealed tab whenever it can, until "stop".
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

const run = promisify(execFile);
const [profileDir, sealedTab, ...captured] = process.argv.slice(2);
const report = { heldOpenAtStop: 0, reached: [], read: [] };
const say = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

function open(url) {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const send = (method, params = {}, sessionId) =>
      new Promise((done) => {
        const call = ++id;
        pending.set(call, done);
        socket.send(JSON.stringify({ id: call, method, params, ...(sessionId ? { sessionId } : {}) }));
        setTimeout(() => done({ error: "timeout" }), 2000);
      });
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(String(data));
      pending.get(message.id)?.(message);
    });
    socket.addEventListener("open", () => resolve({ socket, send }));
    socket.addEventListener("error", () => resolve(undefined));
    setTimeout(() => resolve(undefined), 2000);
  });
}
/** Every browser-level endpoint another process could find on this machine. */
async function discover() {
  const found = new Set(captured);
  const published = await readFile(join(profileDir, "DevToolsActivePort"), "utf8").catch(() => "");
  const [port, path] = published.trim().split("\n");
  if (port && path) found.add(`ws://127.0.0.1:${port}${path}`);
  const { stdout } = await run("ps", ["-axo", "pid=,command="]);
  for (const line of stdout.split("\n")) {
    if (!line.includes(`--user-data-dir=${profileDir}`)) continue;
    const pid = line.trim().split(/\s+/u)[0];
    const listening = await run("lsof", ["-a", "-p", pid, "-iTCP", "-sTCP:LISTEN", "-nP", "-Fn"]).catch(
      () => ({ stdout: "" }),
    );
    for (const name of listening.stdout.split("\n").filter((entry) => entry.startsWith("n"))) {
      const at = name.slice(1).replace(/^\*/u, "127.0.0.1");
      const version = await fetch(`http://${at}/json/version`).then(
        (response) => response.json(),
        () => undefined,
      );
      if (version?.webSocketDebuggerUrl) found.add(version.webSocketDebuggerUrl);
    }
  }
  return [...found];
}
/** Attach to the sealed tab over one connection and read what its fields hold. */
async function read(connection, label) {
  const attached = await connection.send("Target.attachToTarget", { targetId: sealedTab, flatten: true });
  const sessionId = attached.result?.sessionId;
  if (!sessionId) return;
  report.reached.push(label);
  const value = await connection.send(
    "Runtime.evaluate",
    {
      expression:
        "JSON.stringify([location.href, ...[...document.querySelectorAll('input')].map((e) => e.value)])",
      returnByValue: true,
    },
    sessionId,
  );
  report.read.push(value.result?.result?.value ?? "");
}

const held = [];
for (const url of await discover()) {
  const connection = await open(url);
  if (!connection) continue;
  const targets = await connection.send("Target.getTargets");
  if (targets.result) held.push({ url, ...connection });
}
say({ ready: true, held: held.length });

let stopping = false;
const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  if (line === "stop") {
    stopping = true;
    return;
  }
  if (line !== "go") return;
  while (!stopping) {
    for (const connection of held) {
      if (connection.socket.readyState === WebSocket.OPEN) await read(connection, `held ${connection.url}`);
    }
    for (const url of await discover()) {
      const connection = await open(url);
      if (!connection) continue;
      await read(connection, `fresh ${url}`);
      connection.socket.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  report.heldOpenAtStop = held.filter((connection) => connection.socket.readyState === WebSocket.OPEN).length;
  say(report);
  process.exit(0);
});
