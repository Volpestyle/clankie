// Manual composition proof, not CI. Invoked by run.mjs under clankie heavy.
import { cp, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { loadavg, cpus } from "node:os";
import { resolve, join } from "node:path";
import { build } from "../../node_modules/esbuild/lib/main.js";
import { chromium } from "../../apps/clankie/node_modules/playwright-core/index.mjs";
import { serve } from "../../apps/clankie/node_modules/@hono/node-server/dist/index.mjs";
import { TAKE_CONTROL_GRANTS } from "../../packages/protocol/src/index.ts";
import { createLocalTracker, readTrackerStoreSnapshot } from "../../packages/work-items/src/index.ts";
import { ControlPlaneDeviceAuthorizer } from "../../apps/relay/src/device-auth.ts";
import { createDeviceConversationDispatch } from "../../apps/relay/src/conversation-upstream.ts";
import { createOperatorConversationRelayHandler } from "../../apps/relay/src/operator-conversations.ts";
import { fixture } from "../../docs/testing/2026-10-27-local-vuh-46-peak-day/flows/fixture.ts";

const [appCheckout, source, output, root] = process.argv.slice(2);
if (!root || !process.env.HOME?.startsWith(root) || process.env.NODE_ENV !== "test")
  throw new Error("Scratch launcher required");
const save = (name: string, data: unknown) => writeFile(join(output, name), JSON.stringify(data, null, 2));
const log: Record<string, any>[] = [];
const measurements: Record<string, any>[] = [];
const loads: unknown[] = [];
const commits: { key: string; at: number }[] = [];
const requests: Record<string, any>[] = [];
const started = Date.now();
const sample = () => loads.push({ at: Date.now(), load: loadavg(), rss: process.memoryUsage().rss });
sample();
const loadTimer = setInterval(sample, 5_000);
const directory = join(root, "tracker");
await cp(source, directory, { recursive: true, filter: (path) => !path.includes("tracker.pre-journal-") });
const seeded = createLocalTracker({ directory });
await seeded.checkpoint();
const rawSeed: any = await readTrackerStoreSnapshot(directory);
const seedCounts = Object.fromEntries(
  ["issues", "comments", "events", "audit", "receipts", "bundles"].map((key) => [
    key,
    rawSeed[key]?.length ?? 0,
  ]),
);
await save("seed.json", {
  source,
  counts: seedCounts,
  syncId: rawSeed.syncId,
  checkpointBytes: (await stat(join(directory, "tracker.json"))).size,
});
console.log("seed", seedCounts);
const observe = (backend: any) => ({
  ...backend,
  async call(name: string, args: any, options: any) {
    return backend.call(name, args, {
      ...options,
      effectConfirmed() {
        options?.effectConfirmed?.();
        if (args.idempotencyKey?.startsWith("peak-"))
          commits.push({ key: args.idempotencyKey, at: Date.now() });
      },
    });
  },
});
const f = await fixture(root, directory, observe);
const servers: Server[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let running = true;
const readerAbort = new AbortController();
let readerTask: Promise<void> | undefined;
const active = new Set<Promise<unknown>>();
const track = <T>(promise: Promise<T>) => {
  active.add(promise);
  // allow-swallowed-rejection -- only the bookkeeping branch; the HTTP caller still receives the original rejection.
  void promise.finally(() => active.delete(promise)).catch(() => {});
  return promise;
};
async function listen(server: Server) {
  servers.push(server);
  if (!server.listening) {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
  }
  return `http://127.0.0.1:${(server.address() as any).port}`;
}
const canonical = (value: any): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .filter((key) => value[key] !== undefined)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
const hash = (value: any) => createHash("sha256").update(canonical(value)).digest("hex");
const lazy: Record<string, string[]> = {
  comment: ["body", "quotedText"],
  event: ["body"],
  run: ["summary", "worktree", "branch"],
};
function normalized(model: any) {
  const data = { ...model.data };
  delete data.unhydratedFields;
  for (const field of lazy[model.modelName] ?? []) delete data[field];
  return {
    modelName: model.modelName,
    modelId: model.modelId,
    projectIds: [...model.projectIds].sort(),
    data,
  };
}
const digests = (models: any[]) =>
  Object.fromEntries(
    models
      .map((model) => [`${model.modelName}:${model.modelId}`, hash(normalized(model))])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
try {
  const hostServer = serve({
    fetch: (request) => track(Promise.resolve(f.app.app.fetch(request))),
    hostname: "127.0.0.1",
    port: 0,
  }) as Server;
  servers.push(hostServer);
  if (!hostServer.listening) await once(hostServer, "listening");
  const origin = `http://127.0.0.1:${(hostServer.address() as any).port}`;
  const post = async (path: string, data: any, token = "owner", signal?: AbortSignal) =>
    fetch(origin + path, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(data),
      signal,
    });
  const lead = async (name: string, args: any, signal?: AbortSignal) => {
    requests.push({ audience: "lead", name, at: Date.now(), waitMs: args.waitMs });
    const response = await post("/v1/tracker/call", { name, arguments: args }, "owner", signal);
    const body: any = await response.json();
    if (!response.ok || body.error) throw new Error(JSON.stringify(body));
    return body.result;
  };
  const relayHandler = createOperatorConversationRelayHandler({
    authorizeDevice: new ControlPlaneDeviceAuthorizer({ baseUrl: origin }),
    deviceDispatch: createDeviceConversationDispatch({ baseUrl: origin }),
    dispatch: async () => {
      throw new Error("No captain dispatch in proof");
    },
  });
  const relayOrigin = await listen(
    createServer((request, response) => {
      void track(relayHandler(request, response));
    }),
  );
  const offer: any = await (await post("/v1/pairing/offer", {})).json();
  const pending: any = await (
    await post("/v1/pairing/redeem", {
      offerSecret: new URL(offer.deepLink).searchParams.get("offer"),
      device: { name: "peak-day-web-scratch", platform: "unknown" },
    })
  ).json();
  const device: any = await (
    await post("/v1/pairing/complete", {
      completionToken: pending.completionToken,
      acceptedGrants: TAKE_CONTROL_GRANTS,
    })
  ).json();
  if (!device.deviceToken) throw new Error(`Scratch pairing refused: ${JSON.stringify(device)}`);
  const bundle = await build({
    entryPoints: [resolve("docs/testing/2026-10-27-local-vuh-46-peak-day/flows/browser.ts")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    alias: {
      "proof-app-pool": join(appCheckout, "packages/command-center/src/workItems/syncPool.ts"),
      "proof-app-storage": join(appCheckout, "packages/command-center/src/workItems/syncStorage.ts"),
      "@clankie/protocol": resolve("packages/protocol/src/index.ts"),
    },
  });
  const web = await listen(
    createServer(async (request, response) => {
      if (request.url === "/sync") {
        try {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const command = JSON.parse(Buffer.concat(chunks).toString());
          const abort = new AbortController();
          response.on("close", () => abort.abort());
          requests.push({ audience: "app", name: command.action, at: Date.now(), waitMs: command.waitMs });
          const upstream = await fetch(relayOrigin + "/operator/v1/dispatch", {
            method: "POST",
            headers: { authorization: request.headers.authorization!, "content-type": "application/json" },
            body: JSON.stringify({ op: "tracker_sync", schemaVersion: 1, command }),
            signal: abort.signal,
          });
          const result =
            command.action === "bootstrap" && upstream.ok
              ? { outcome: "bootstrap", ndjson: await upstream.text() }
              : ((await upstream.json()) as any).result;
          response.writeHead(upstream.status, { "content-type": "application/json" });
          response.end(JSON.stringify(result));
        } catch (error) {
          if (!response.destroyed) {
            response.writeHead(500);
            response.end(String(error));
          }
        }
      } else if (request.url === "/client.js") {
        response.setHeader("content-type", "text/javascript");
        response.end(bundle.outputFiles[0]!.contents);
      } else {
        response.setHeader("content-type", "text/html");
        response.end(
          '<!doctype html><meta charset="utf-8"><title>LOCAL-VUH-46 · scratch Work pool</title><style>body{font:20px system-ui;background:#101820;color:#c9f2db;padding:60px}pre{line-height:1.8}</style><h1>Peak fleet day · browser Work pool</h1><p>Unmodified app sync pool + IndexedDB · scratch pairing · real HTTP relay</p><pre>Connecting…</pre><script src="/client.js"></script>',
        );
      }
    }),
  );
  const sessions = new Map<string, string>();
  let sequence = 0;
  const rpc = async (pane: string, method: string, params: any) =>
    fetch(origin + "/v1/fleet/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer local-fleet-test",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-test-local-pane": pane,
        ...(sessions.has(pane) ? { "mcp-session-id": sessions.get(pane)! } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    });
  const worker = async (pane: string, name: string, args: any) => {
    requests.push({ audience: pane, name, at: Date.now() });
    const response = await rpc(pane, "tools/call", {
      name: "clankie_call",
      arguments: { name: `linear_${name}`, arguments: args },
    });
    const body: any = await response.json();
    const reply = JSON.parse(body.result.content[0].text);
    if (reply.outcome !== "ok") throw new Error(JSON.stringify(reply));
    return JSON.parse(reply.content);
  };
  for (let index = 0; index < 4; index++) {
    const pane = `worker-${index}`;
    await f.hire(pane, "builder");
    const response = await rpc(pane, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "peak-day-proof", version: "1" },
    });
    sessions.set(pane, response.headers.get("mcp-session-id")!);
  }
  browser = await chromium.launch({
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--disable-background-networking", "--disable-component-update", "--no-first-run"],
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 620 } });
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(String(error)));
  await page.goto(web);
  await page.evaluate((token) => (window as any).start(token), device.deviceToken);
  await page.waitForFunction(() => (window as any).snapshot()?.confirmedStoreId, null, { timeout: 120_000 });
  const initial = await f.tracker.sync({ action: "bootstrap", type: "full", projects: ["*"], lazy: true });
  if (initial.outcome !== "bootstrap") throw new Error("Initial bootstrap refused");
  const lines = initial.ndjson
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const metadata = lines.pop();
  const agent = new Map(
    lines.map((line) => {
      const model = line.kind === "model" ? line.model : line;
      return [`${model.modelName}:${model.modelId}`, model];
    }),
  );
  const snapshot = await lead("list_issues", { project: f.project.id, snapshot: true, limit: 250 });
  if (snapshot.syncId !== metadata.lastSyncId) throw new Error("Initial reader boundaries differ");
  let cursor = snapshot.syncId;
  const agentPages: unknown[] = [];
  let readerError: string | undefined;
  readerTask = (async () => {
    while (running) {
      const page = await lead(
        "list_changes",
        { project: f.project.id, since: cursor, storeId: snapshot.storeId, waitMs: 20_000, limit: 100 },
        readerAbort.signal,
      );
      if (page.outcome !== "changes") throw new Error(JSON.stringify(page));
      agentPages.push({
        at: Date.now(),
        from: cursor,
        to: page.syncId,
        commits: page.changes.map((entry: any) => ({
          syncId: entry.syncId,
          key: entry.idempotencyKey,
          changes: entry.changes.length,
        })),
      });
      for (const commit of page.changes)
        for (const change of commit.changes) {
          const key = `${change.model}:${change.id}`;
          if (change.action === "delete") agent.delete(key);
          else {
            const old: any = agent.get(key);
            const data =
              change.action === "insert" ? { ...change.fields } : { ...old?.data, ...change.fields };
            for (const field of change.removedFields ?? []) delete data[field];
            agent.set(key, {
              modelName: change.model,
              modelId: change.id,
              projectIds: old?.projectIds ?? [f.project.id],
              data,
            });
          }
        }
      cursor = page.syncId;
    }
  })().catch((error) => {
    if (!readerAbort.signal.aborted) readerError = String(error);
  });
  const trafficStarted = Date.now();
  // 75 create + 273 comment + 246 priority/state updates = 594 writes / 840 events.
  // Five real concurrent lanes; 17 creates in the initial burst. Each lane owns
  // its issue IDs, avoiding client-side stale updates. Budget clock stays real.
  const issues: string[][] = Array.from({ length: 5 }, () => []);
  const calls = Array.from({ length: 5 }, (_, actor) =>
    actor < 4 ? (name: string, args: any) => worker(`worker-${actor}`, name, args) : lead,
  );
  let intent = 0;
  async function write(actor: number, name: string, args: any) {
    const number = ++intent,
      key = `peak-${String(number).padStart(4, "0")}`;
    const before = Date.now();
    // At the client boundary, deliberately discard the acknowledged write reply.
    // Reconcile the same original through get_write_receipt; never resend a write.
    let result = await calls[actor]!(name, { ...args, idempotencyKey: key });
    const lost = number % 29 === 0;
    if (lost) {
      result = undefined;
      const receipt = await calls[actor]!("get_write_receipt", { idempotencyKey: key });
      if (receipt.state !== "applied") throw new Error(`Receipt reconciliation failed: ${key}`);
      result = receipt.result;
      log.push({ kind: "lost-response-reconciled", actor, key, state: receipt.state });
    }
    measurements.push({ number, actor, key, name, requestAt: before, responseAt: Date.now(), lost });
    if (measurements.length % 50 === 0) console.log(`writes settled: ${measurements.length}/594`);
    return result;
  }
  const phases = [4, 4, 3, 3, 3];
  await Promise.all(
    calls.map(async (_, actor) => {
      for (let index = 0; index < phases[actor]!; index++)
        issues[actor]!.push(
          (
            await write(actor, "save_issue", {
              title: `Peak ${actor}/${index}`,
              team: f.team,
              project: f.project.id,
            })
          ).id,
        );
    }),
  );
  const burstEnd = Date.now();
  await Promise.all(
    calls.map(async (_, actor) => {
      for (let index = phases[actor]!; index < 15; index++) {
        issues[actor]!.push(
          (
            await write(actor, "save_issue", {
              title: `Peak ${actor}/${index}`,
              team: f.team,
              project: f.project.id,
            })
          ).id,
        );
        await new Promise((resolve) => setTimeout(resolve, 1_100));
      }
      const count = actor < 4 ? 104 : 103;
      const states = new Map<string, number>();
      for (let index = 0; index < count; index++) {
        const issueId = issues[actor]![index % 15]!;
        // First 49 updates per actor plus one on the lead: 246, exactly.
        if (index < (actor === 4 ? 50 : 49)) {
          const turn = (states.get(issueId) ?? 0) + 1;
          states.set(issueId, turn);
          await write(actor, "save_issue", {
            id: issueId,
            priority: turn % 2 ? 2 : 3,
            state: turn % 2 ? "Backlog" : "Todo",
          });
        } else
          await write(actor, "save_comment", {
            issueId,
            body: `Peak day evidence actor=${actor} event=${index}`,
          });
        await new Promise((resolve) => setTimeout(resolve, 1_100));
      }
    }),
  );
  const trafficEnded = Date.now();
  const after: any = await readTrackerStoreSnapshot(directory);
  const head = after.syncId;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const appHead = await page.evaluate(() => (window as any).snapshot().lastSyncId);
    if (appHead === head && cursor === head) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const idleStarted = Date.now();
  console.log(`traffic ended; starting 10-minute idle window at ${new Date(idleStarted).toISOString()}`);
  // Lead-requested 10 minutes catches readers whose timer exceeds a few seconds.
  await new Promise((resolve) => setTimeout(resolve, 600_000));
  const capture: any = await page.evaluate(() => (window as any).capture());
  await page.screenshot({ path: join(output, "browser.png") });
  const final = await f.tracker.sync({ action: "bootstrap", type: "full", projects: ["*"], lazy: true });
  if (final.outcome !== "bootstrap") throw new Error("Final bootstrap refused");
  const finalLines = final.ndjson
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  finalLines.pop();
  const expected = digests(finalLines.map((line) => (line.kind === "model" ? line.model : line)));
  const appModels = digests(capture.snapshot.models),
    agentModels = digests([...agent.values()]);
  const mismatch = (observed: any) =>
    [...new Set([...Object.keys(expected), ...Object.keys(observed)])].filter(
      (key) => expected[key] !== observed[key],
    );
  const syncByKey = new Map(
    (after.syncLog ?? [])
      .filter((commit: any) => commit.idempotencyKey?.startsWith("peak-"))
      .map((commit: any) => [commit.idempotencyKey, commit.syncId]),
  );
  const latencies = commits.map((commit) => {
    const syncId = syncByKey.get(commit.key) as number;
    const seen = capture.seen.find((entry: any) => entry.cursor >= syncId);
    return { ...commit, syncId, appAt: seen?.at, ms: seen ? seen.at - commit.at : null };
  });
  const sorted = latencies.flatMap((entry) => (entry.ms === null ? [] : [entry.ms])).sort((a, b) => a - b);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  const receipts = after.receipts.filter((receipt: any) => receipt.idempotencyKey?.startsWith("peak-"));
  const audit = after.audit.filter((entry: any) => entry.idempotencyKey?.startsWith("peak-"));
  const duplicateKeys = [...new Set(receipts.map((receipt: any) => receipt.idempotencyKey))].filter(
    (key) => receipts.filter((receipt: any) => receipt.idempotencyKey === key).length !== 1,
  );
  const budget = f.budget.report();
  const periodic = requests.filter(
    (entry) =>
      entry.at >= trafficStarted &&
      ((entry.audience === "app" && entry.name !== "subscribe") ||
        (entry.audience !== "app" && entry.name.startsWith("list_") && entry.name !== "list_changes")),
  );
  const summary = {
    started,
    ended: Date.now(),
    core: process.cwd(),
    appCheckout,
    node: process.version,
    cores: cpus().length,
    root,
    isolation: {
      home: process.env.HOME,
      origin,
      relayOrigin,
      web,
      pairing: "scratch signed device; no owner pairing/broker/keychain",
      nativeMac: "not exercised (Keychain/owner-prompt boundary)",
    },
    seedCounts,
    traffic: {
      writes: intent,
      newIssues: after.issues.length - rawSeed.issues.length,
      newEvents: after.events.length - rawSeed.events.length,
      burstCreates: 17,
      burstMs: burstEnd - trafficStarted,
      durationMs: trafficEnded - trafficStarted,
      idleMs: Date.now() - idleStarted,
    },
    ac1: {
      receipts: receipts.length,
      audit: audit.length,
      applied: receipts.filter((receipt: any) => receipt.state === "applied").length,
      duplicateKeys,
      lostResponses: log.length,
      resends: 0,
    },
    ac2: {
      storeModels: Object.keys(expected).length,
      appModels: Object.keys(appModels).length,
      agentModels: Object.keys(agentModels).length,
      appMismatches: mismatch(appModels),
      agentMismatches: mismatch(agentModels),
      appCursor: capture.snapshot.lastSyncId,
      agentCursor: cursor,
      storeCursor: head,
      readerError,
      browserErrors,
    },
    ac3: {
      samples: sorted.length,
      missing: latencies.filter((entry) => entry.ms === null).length,
      p95Ms: p95,
      maxMs: sorted.at(-1),
      budget,
    },
    ac4: { periodicReads: periodic, appRequests: capture.requests, agentPages },
    comparison:
      "Every model and field in the lazy wire projection; omitted lazy bodies excluded for all three. No models skipped.",
    boundary:
      "Real WorkSyncPool/IndexedDB in headless Chromium; HTTP host/relay + scratch signed pairing; simulated local pane identity as existing integration fixture, real hire records and MCP sessions. No full World UI or native harness processes.",
  };
  await save("model-digests.json", { store: expected, app: appModels, agent: agentModels });
  await save("latencies.json", latencies);
  await save("summary.json", summary);
  await save("requests.json", requests);
  await save("writes.json", measurements);
  await save("reconciliations.json", log);
  console.log(
    JSON.stringify(
      {
        ...summary,
        ac4: {
          periodicReads: periodic.length,
          appRequests: capture.requests.length,
          agentPages: agentPages.length,
        },
      },
      null,
      2,
    ),
  );
} catch (error) {
  await save("failure.json", {
    at: Date.now(),
    error: String(error),
    stack: (error as Error).stack,
    measurements,
    log,
  });
  console.error(error);
  process.exitCode = 1;
} finally {
  running = false;
  readerAbort.abort();
  await readerTask;
  await browser?.close();
  for (const server of servers.reverse()) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  f.close();
  await Promise.allSettled(active);
  clearInterval(loadTimer);
  sample();
  await save("load.json", loads);
}
