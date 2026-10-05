import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { join } from "node:path";

// Implement the actual framed relay transport over real child stdio and TCP.
// The remote PowerShell/C# runtime is the sole fixture boundary here.
export async function startRelay(returnPort) {
  const root = process.env.CLANKIE_FLEET_SSH_FIXTURE;
  const record = (kind, extra = {}) =>
    appendFileSync(
      join(root, "relay.jsonl"),
      `${JSON.stringify({ kind, pid: process.pid, time: Date.now(), ...extra })}\n`,
    );
  const send = (kind, id, payload = Buffer.alloc(0)) => {
    const frame = Buffer.alloc(9 + payload.length);
    frame[0] = kind;
    frame.writeUInt32LE(id, 1);
    frame.writeUInt32LE(payload.length, 5);
    payload.copy(frame, 9);
    process.stdout.write(frame);
  };
  const nonce = randomBytes(32);
  send(5, 0, nonce);
  const control = createConnection({ host: "127.0.0.1", port: returnPort });
  const clients = new Map();
  const timers = new Set();
  let next = 0;
  let closed = false;
  let watcher;
  let delayed = false;
  let delayUsed = false;
  let input = Buffer.alloc(0);
  const remote = createServer((socket) => {
    const id = ++next;
    clients.set(id, socket);
    const tuple = Buffer.alloc(8);
    tuple.writeUInt32LE(socket.remotePort, 0);
    tuple.writeUInt32LE(socket.localPort, 4);
    send(1, id, tuple);
    socket.on("data", (bytes) => send(2, id, bytes));
    socket.once("error", () => socket.destroy());
    socket.once("close", () => {
      clients.delete(id);
      if (!closed) {
        record("stream-ack", { id });
        send(3, id);
      }
    });
  });
  const close = () => {
    if (closed) return;
    closed = true;
    record("relay-exit");
    clearInterval(watcher);
    for (const timer of timers) clearTimeout(timer);
    for (const socket of clients.values()) socket.destroy();
    control.destroy();
    if (remote.listening) remote.close();
  };
  process.once("SIGTERM", close);
  control.once("error", close);
  control.once("close", close);
  control.once("connect", () => control.write(nonce));
  const consume = () => {
    if (closed || delayed) return;
    while (input.length >= 9) {
      const kind = input[0];
      const id = input.readUInt32LE(1);
      const length = input.readUInt32LE(5);
      if (input.length < 9 + length) return;
      if ((kind === 2 || kind === 3) && !delayUsed) {
        const delay = JSON.parse(readFileSync(join(root, "login.json"), "utf8")).responseDelayMs ?? 0;
        if (delay > 0) {
          delayUsed = true;
          delayed = true;
          control.pause();
          record("response-paused");
          const timer = setTimeout(() => {
            timers.delete(timer);
            delayed = false;
            record("response-resumed");
            consume();
            control.resume();
          }, delay);
          timers.add(timer);
          return;
        }
      }
      const bytes = input.subarray(9, 9 + length);
      input = input.subarray(9 + length);
      if (kind === 6 && id === 0 && length === 0) {
        remote.close();
        record("drain-ack");
        send(6, 0);
      } else if (kind === 4) {
        record("execute-start", { id, script: bytes.toString("utf8") });
        const delay = JSON.parse(readFileSync(join(root, "login.json"), "utf8")).proofDelayMs ?? 0;
        const timer = setTimeout(() => {
          timers.delete(timer);
          if (closed) return;
          send(4, id, Buffer.from("proof-complete", "utf8"));
          record("execute-result", { id });
        }, delay);
        timers.add(timer);
      } else if (kind === 2) clients.get(id)?.write(bytes);
      else if (kind === 3) {
        const client = clients.get(id);
        // Queue EOF after prior response writes, and echo close only once
        // the socket's queued bytes have reached the remote HTTP client.
        if (client) client.end();
        else send(3, id);
      } else throw new Error("Unknown service relay frame");
    }
  };
  control.on("data", (chunk) => {
    input = Buffer.concat([input, chunk]);
    consume();
  });
  await new Promise((resolve) => remote.listen(0, "127.0.0.1", resolve));
  const port = remote.address().port;
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(port);
  send(0, 0, bytes);
  record("relay-ready", { port });
  watcher = setInterval(() => {
    if (existsSync(join(root, `stop-relay-${process.pid}`))) close();
  }, 20);
  watcher.unref();
}
