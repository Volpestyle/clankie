import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";

// A single control-only localhost connection, held for the original Pi process.
// No reconnect, terminal input, history cache, MCP registry, or model runtime.
export function connectPiWorker({ port, token }, createRuntime) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[a-f0-9]{64}$/u.test(token))
    throw new Error("Invalid prepared Pi controller");
  const socket = createConnection({ host: "127.0.0.1", port });
  const pending = new Map();
  let ready = false;
  let closed = false;
  let text = "";
  let pendingBytes = 0;
  const decoder = new StringDecoder("utf8");
  const close = () => {
    if (closed) return;
    closed = true;
    ready = false;
    socket.destroy();
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("Pi controller connection ended"));
    }
    pending.clear();
    runtime.close();
  };
  const request = (method, input) =>
    new Promise((resolve, reject) => {
      if (!ready || closed) return reject(new Error("Original Pi controller unavailable"));
      const id = randomUUID();
      const timer = setTimeout(() => {
        close();
      }, 10_000);
      pending.set(id, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ id, method, input })}\n`);
    });
  const runtime = createRuntime({
    connected: () => ready && !closed,
    authorize: (action) => request("authorize", { action }),
    claim: (input) => request("claim", input),
    receipt: (input) => request("receipt", input),
    close,
  });
  const handle = async (frame) => {
    if (!ready) {
      if (frame.ready !== true) return close();
      ready = true;
      return;
    }
    if (typeof frame.id !== "string" || frame.id.length > 100) return close();
    if (frame.method === undefined) {
      const item = pending.get(frame.id);
      if (!item) return;
      pending.delete(frame.id);
      clearTimeout(item.timer);
      if (frame.error) item.reject(new Error("Controller refused native action"));
      else item.resolve(frame.result);
      return;
    }
    if (!["initialize", "status", "send", "settlement", "interrupt"].includes(frame.method)) return close();
    try {
      const result = await runtime[frame.method](frame.input);
      if (!closed) socket.write(`${JSON.stringify({ id: frame.id, result })}\n`);
    } catch {
      if (!closed)
        socket.write(`${JSON.stringify({ id: frame.id, error: "Native Pi action unavailable" })}\n`);
    }
  };
  socket.once("connect", () => socket.write(`${JSON.stringify({ token })}\n`));
  socket.on("error", close);
  socket.on("close", close);
  socket.on("data", (chunk) => {
    pendingBytes += chunk.length;
    text += decoder.write(chunk);
    if (pendingBytes > 1024 * 1024) return close();
    while (text.includes("\n")) {
      const end = text.indexOf("\n");
      const line = text.slice(0, end);
      text = text.slice(end + 1);
      pendingBytes = Math.max(0, pendingBytes - Buffer.byteLength(line) - 1);
      try {
        void handle(JSON.parse(line)).catch(close);
      } catch {
        close();
      }
    }
  });
  return { close };
}
