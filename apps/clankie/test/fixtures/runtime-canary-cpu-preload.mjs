/** Manual proof only: observe real HTTP timing and optionally burn CPU after a private trigger. */
import { appendFileSync, existsSync } from "node:fs";
import { channel } from "node:diagnostics_channel";
import { isAbsolute, relative } from "node:path";
import { performance } from "node:perf_hooks";

const trigger = process.env.CLANKIE_CANARY_CPU_TRIGGER;
const home = process.env.HOME;
const trace = process.env.CLANKIE_CANARY_REQUEST_TRACE;
function privatePath(path) {
  if (!home || !isAbsolute(path) || relative(home, path).startsWith(".."))
    throw Error("Canary proof file must belong to its isolated HOME");
}
if (trace) {
  privatePath(trace);
  const requests = new WeakMap();
  const serverRequests = new WeakMap();
  let ordinal = 0;
  let activeHealth;
  channel("undici:request:create").subscribe(({ request }) => {
    if (request.path !== "/health") return;
    activeHealth = { ordinal: ++ordinal, began: performance.now() };
    requests.set(request, activeHealth);
  });
  channel("http.server.request.start").subscribe(({ request }) => {
    // The real sampler has no authorization header; external proof probes do.
    if (request.url !== "/health" || request.headers.authorization || !activeHealth) return;
    activeHealth.serverArrivedAt = performance.now();
    serverRequests.set(request, activeHealth);
  });
  channel("http.server.response.finish").subscribe(({ request }) => {
    const started = serverRequests.get(request);
    if (started) started.serverFinishedAt = performance.now();
  });
  channel("undici:request:headers").subscribe(({ request }) => {
    const started = requests.get(request);
    if (started) started.headersAt = performance.now();
  });
  channel("undici:request:trailers").subscribe(({ request }) => {
    const started = requests.get(request);
    if (!started) return;
    // Observe the real HTTP request; never replace fetch, a response, or a product authority.
    const completed = performance.now();
    appendFileSync(
      trace,
      `${JSON.stringify({
        ordinal: started.ordinal,
        completedAt: new Date().toISOString(),
        requestLatencyMs: completed - started.began,
        ...(started.serverArrivedAt === undefined
          ? {}
          : {
              beforeServerMs: started.serverArrivedAt - started.began,
            }),
        ...(started.serverFinishedAt === undefined
          ? {}
          : {
              serverHandlingMs: started.serverFinishedAt - started.serverArrivedAt,
              afterServerMs: completed - started.serverFinishedAt,
            }),
        ...(started.headersAt === undefined ? {} : { headersMs: started.headersAt - started.began }),
      })}\n`,
      { mode: 0o600 },
    );
    if (activeHealth === started) activeHealth = undefined;
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
