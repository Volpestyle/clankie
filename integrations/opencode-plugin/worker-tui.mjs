// Loaded by OpenCode's TUI plugin host, separately from server plugins.
// Pinned OpenTUI 0.4.5 aliases these imports to the host's shared Solid runtime.
import { createComputed, createRoot } from "solid-js";
import { createOpenCodeWorkerRuntime, WORKER_OPENCODE_VERSION } from "./worker-runtime.mjs";

export const id = "clankie-native-worker";

export async function tui(api, options) {
  if (api.app.version !== WORKER_OPENCODE_VERSION)
    throw new Error(`Clankie workers require OpenCode ${WORKER_OPENCODE_VERSION}`);
  const address = new URL(options?.endpoint ?? "");
  if (
    address.protocol !== "ws:" ||
    address.hostname !== "127.0.0.1" ||
    address.pathname !== "/worker" ||
    address.username ||
    address.password ||
    address.search ||
    address.hash ||
    !/^[a-f0-9]{64}$/u.test(options?.token ?? "")
  )
    throw new Error("Invalid native worker controller");
  const socket = new WebSocket(address, ["clankie-native-worker", options.token]);
  let connected = false;
  let sequence = 0;
  let initialized = false;
  const pending = new Map();
  const request = (method, input) =>
    new Promise((resolve, reject) => {
      if (!connected) return reject(new Error("Controller unavailable"));
      const requestId = `native-${++sequence}`;
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("Controller reply unavailable"));
      }, 10_000);
      pending.set(requestId, { resolve, reject, timeout });
      socket.send(JSON.stringify({ id: requestId, method, input }));
    });
  const runtime = createOpenCodeWorkerRuntime(api, {
    connected: () => connected,
    watchRoute: (observe) =>
      createRoot((dispose) => {
        createComputed(observe);
        return dispose;
      }),
    authorize: (action) => request("authorize", { action }),
    claim: (claim) => request("claim", claim),
    receipt: (receipt) => request("receipt", receipt),
  });
  let finishInitialization;
  let failInitialization;
  const initialization = new Promise((resolve, reject) => {
    finishInitialization = resolve;
    failInitialization = reject;
  });
  const startup = setTimeout(
    () => failInitialization(new Error("Worker initialization unavailable")),
    20_000,
  );
  const close = () => {
    connected = false;
    runtime.close();
    clearTimeout(startup);
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("Original controller disconnected; no reconnect or resend"));
    }
    pending.clear();
    failInitialization(new Error("Original controller disconnected"));
  };
  api.lifecycle.onDispose(() => {
    close();
    socket.close();
  });
  socket.addEventListener("close", close);
  socket.addEventListener("error", close);
  socket.addEventListener("open", () => {
    connected = true;
  });
  socket.addEventListener("message", async (event) => {
    if (typeof event.data !== "string" || event.data.length > 1024 * 1024) return socket.close();
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      socket.close();
      return;
    }
    if (typeof message.id !== "string") return socket.close();
    if (!message.method) {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timeout);
      if (message.error) waiter.reject(new Error("Controller refused native action"));
      else waiter.resolve(message.result);
      return;
    }
    try {
      let result;
      if (message.method === "initialize") {
        if (initialized) throw new Error("No reload or reinitialization");
        initialized = true;
        result = await runtime.initialize(message.input);
      } else {
        if (!initialized) throw new Error("Native worker is not initialized");
        if (message.method === "status") result = await runtime.status();
        else if (message.method === "send") result = await runtime.send(message.input);
        else if (message.method === "history") result = await runtime.history();
        else if (message.method === "settlement") result = await runtime.settlement(message.input);
        else if (message.method === "interrupt") result = await runtime.interrupt();
        else throw new Error("Unsupported native worker action");
      }
      if (!connected) return;
      socket.send(JSON.stringify({ id: message.id, result }));
      if (message.method === "initialize") {
        clearTimeout(startup);
        finishInitialization();
      }
    } catch {
      if (connected)
        socket.send(JSON.stringify({ id: message.id, error: "Native worker action unavailable" }));
      if (message.method === "initialize")
        failInitialization(new Error("Native worker initialization failed"));
    }
  });
  // app.tsx awaits this first call before mounting either native prompt. A
  // reload has no fresh controller admission and cannot reach initialization.
  try {
    await initialization;
  } catch (error) {
    close();
    socket.close();
    throw error;
  }
}

// OpenCode 1.18.18's readV1Plugin loads the TUI entry from a default object.
export default { id, tui };
