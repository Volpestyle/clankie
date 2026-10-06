/** Manual proof only: observe real HTTP timing and optionally burn CPU after a private trigger. */
import { appendFileSync, existsSync } from "node:fs";
import { channel } from "node:diagnostics_channel";
import { isAbsolute, relative } from "node:path";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const trigger = process.env.CLANKIE_CANARY_CPU_TRIGGER;
const home = process.env.HOME;
const trace = process.env.CLANKIE_CANARY_REQUEST_TRACE;
function privatePath(path) {
  if (!home || !isAbsolute(path) || relative(home, path).startsWith(".."))
    throw Error("Canary proof file must belong to its isolated HOME");
}
if (trace) {
  privatePath(trace);
  const rows = [];
  const record = (row) => rows.push({ observedAt: new Date().toISOString(), ...row });
  const initialUtilization = performance.eventLoopUtilization();
  // Buffer observations so trace I/O does not enter the measured request path.
  process.once("exit", () => {
    record({ kind: "event-loop-total", ...performance.eventLoopUtilization(initialUtilization) });
    appendFileSync(trace, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, { mode: 0o600 });
  });
  // This diagnostic adds regular wakeups and can mask an idle transport delay.
  // Keep it opt-in; the default socket/ELU observations add no timers.
  if (process.env.CLANKIE_CANARY_EVENT_LOOP_DELAY === "true") {
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    let utilization = performance.eventLoopUtilization();
    const loop = setInterval(() => {
      const now = performance.eventLoopUtilization();
      record({
        kind: "event-loop",
        delayMeanMs: Number.isFinite(delay.mean) ? delay.mean / 1e6 : 0,
        delayMaxMs: delay.max / 1e6,
        delayP95Ms: delay.percentile(95) / 1e6,
        ...performance.eventLoopUtilization(now, utilization),
      });
      utilization = now;
      delay.reset();
    }, 1000);
    loop.unref();
  }
  const requests = new WeakMap();
  const serverRequests = new WeakMap();
  const sockets = new WeakMap();
  const socketInfo = (socket) => {
    let found = sockets.get(socket);
    if (!found) {
      found = { id: ++socketOrdinal, seenAt: performance.now() };
      sockets.set(socket, found);
      socket.once("close", () => record({ kind: "socket-close", socketId: found.id }));
    }
    return found;
  };
  let ordinal = 0;
  let socketOrdinal = 0;
  let activeHealth;
  const beginRequest = (transport) => ({
    transport,
    ordinal: ++ordinal,
    began: performance.now(),
    utilization: performance.eventLoopUtilization(),
  });
  const completeRequest = (started) => {
    const completed = performance.now();
    record({
      kind: "sampler-http",
      transport: started.transport,
      ordinal: started.ordinal,
      completedAt: new Date().toISOString(),
      requestLatencyMs: completed - started.began,
      socketId: started.socketId,
      socketAgeMs: started.socketAgeMs,
      reusedSocket: started.reusedSocket,
      eventLoopUtilization: performance.eventLoopUtilization(started.utilization),
      ...(started.headersSentAt === undefined
        ? {}
        : { dispatchToHeadersMs: started.headersSentAt - started.began }),
      ...(started.headersSentAt === undefined || started.serverArrivedAt === undefined
        ? {}
        : { headersToServerMs: started.serverArrivedAt - started.headersSentAt }),
      ...(started.bodySentAt === undefined
        ? {}
        : { dispatchToBodySentMs: started.bodySentAt - started.began }),
      ...(started.connectedAt === undefined ? {} : { connectMs: started.connectedAt - started.began }),
      ...(started.serverArrivedAt === undefined
        ? {}
        : { beforeServerMs: started.serverArrivedAt - started.began }),
      ...(started.serverFinishedAt === undefined
        ? {}
        : {
            serverHandlingMs: started.serverFinishedAt - started.serverArrivedAt,
            afterServerMs: completed - started.serverFinishedAt,
          }),
      ...(started.headersAt === undefined ? {} : { headersMs: started.headersAt - started.began }),
    });
    if (activeHealth === started) activeHealth = undefined;
  };
  channel("http.client.request.created").subscribe(({ request }) => {
    if (
      request.path !== "/health" ||
      request.getHeader("authorization") ||
      request.getHeader("x-clankie-canary-proof")
    )
      return;
    activeHealth = beginRequest("node:http");
    const started = activeHealth;
    requests.set(request, started);
    request.once("socket", (socket) => {
      const info = socketInfo(socket);
      started.socketId = info.id;
      started.socketAgeMs = performance.now() - info.seenAt;
      started.reusedSocket = request.reusedSocket;
      socket.once("connect", () => {
        started.connectedAt = performance.now();
      });
    });
    request.once("finish", () => {
      started.bodySentAt = performance.now();
    });
    request.once("response", (response) => {
      started.headersAt = performance.now();
      // Observe the existing stream; do not consume, replace, or pause it.
      response.once("end", () => completeRequest(started));
    });
  });
  channel("http.client.request.start").subscribe(({ request }) => {
    const started = requests.get(request);
    if (started) started.headersSentAt = performance.now();
  });
  channel("undici:client:beforeConnect").subscribe(({ connectParams }) => {
    if (connectParams.hostname !== "127.0.0.1") return;
    record({ kind: "client-before-connect", port: connectParams.port });
  });
  channel("undici:client:connected").subscribe(({ connectParams, socket }) => {
    if (connectParams.hostname !== "127.0.0.1") return;
    const info = socketInfo(socket);
    info.connectedAt = performance.now();
    record({ kind: "client-connected", socketId: info.id, port: connectParams.port });
  });
  channel("undici:request:create").subscribe(({ request }) => {
    if (request.path !== "/health") return;
    activeHealth = beginRequest("undici");
    requests.set(request, activeHealth);
  });
  channel("undici:client:sendHeaders").subscribe(({ request, socket }) => {
    const started = requests.get(request);
    if (!started) return;
    const info = socketInfo(socket);
    started.socketId = info.id;
    started.socketAgeMs = performance.now() - (info.connectedAt ?? info.seenAt);
    started.headersSentAt = performance.now();
  });
  channel("undici:request:bodySent").subscribe(({ request }) => {
    const started = requests.get(request);
    if (started) started.bodySentAt = performance.now();
  });
  channel("http.server.request.start").subscribe(({ request }) => {
    if (request.url !== "/health") return;
    const external = request.headers["x-clankie-canary-proof"];
    // All independent probes identify themselves with a metadata-only unique id.
    if (typeof external === "string") {
      serverRequests.set(request, { external, serverArrivedAt: performance.now() });
    } else if (!request.headers.authorization && activeHealth) {
      activeHealth.serverArrivedAt = performance.now();
      serverRequests.set(request, activeHealth);
    }
  });
  channel("http.server.response.finish").subscribe(({ request }) => {
    const started = serverRequests.get(request);
    if (!started) return;
    started.serverFinishedAt = performance.now();
    if (started.external)
      record({
        kind: "independent-server-handler",
        id: started.external,
        serverHandlingMs: started.serverFinishedAt - started.serverArrivedAt,
      });
  });
  channel("undici:request:headers").subscribe(({ request }) => {
    const started = requests.get(request);
    if (started) started.headersAt = performance.now();
  });
  channel("undici:request:trailers").subscribe(({ request }) => {
    const started = requests.get(request);
    if (!started) return;
    completeRequest(started);
  });
}

if (trigger) {
  privatePath(trigger);
  const burn = setInterval(() => {
    if (!existsSync(trigger)) return;
    const began = performance.now();
    while (performance.now() - began < 45) Math.sqrt(performance.now());
  }, 100);
  burn.unref();
}
