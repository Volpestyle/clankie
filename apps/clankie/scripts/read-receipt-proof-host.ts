// Disposable LOCAL-VUH-13 proof host. Production LocalFleetLink admission
// (kernel socket census + live Herdr pane), WorkerMcp, McpHost and the built-in
// tracker serve /v1/fleet/mcp on a private loopback port. Nothing is stubbed.
// Discovery is published only under the private root, never the installed links.
//
//   clankie heavy --server -- node --import ./scripts/dependency-types.mjs \
//     apps/clankie/scripts/read-receipt-proof-host.ts ROOT [--runner] [--journal-records N]
import { serve } from "@hono/node-server";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { createLocalTracker } from "@clankie/work-items";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { LocalFleetLink } from "../src/local-fleet-link.ts";
import { localFleetAdmissionProof, localProjectProof } from "../src/local-fleet-proof.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { linearMcp } from "../src/linear-mcp.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";

const root = process.argv[2];
// Production's built-in tracker carries a host runner; --runner reproduces that shape.
const runner = process.argv.includes("--runner");
// Seeds a receipt journal shaped like a long-lived service's, to measure the READ lock hold.
const journalRecords = Number(process.argv[process.argv.indexOf("--journal-records") + 1] ?? 0);
if (!root || !isAbsolute(root)) throw new Error("Expected an absolute private proof root");
await mkdir(root, { recursive: true, mode: 0o700 });
if ((await readdir(root)).length > 0) throw new Error("The proof root must be new and empty");
const socketPath = process.env.HERDR_SOCKET_PATH?.trim();
if (!socketPath) throw new Error("Run from a native Herdr pane");
// The installed service binds this pane's system Herdr the same way (runtime external).
const binding = async () => ({
  runtime: "external" as const,
  session: process.env.HERDR_SESSION?.trim() || "default",
  socketPath,
});
const log = (event: Record<string, unknown>) =>
  appendFile(
    join(root, "host-events.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`,
    {
      mode: 0o600,
    },
  );
const diagnostics = (event: unknown, pane?: string) => void log({ event: "proof", pane, detail: event });

const settings = new SettingsStore(join(root, "settings.json"));
await settings.update((current) => ({
  ...current,
  fleet: { ...current.fleet, tools: "connected" },
  mcp: { ...current.mcp, servers: [] },
}));
// Empty broker: the built-in tracker needs no provider account.
const credentials = new FileCredentialStore(join(root, "credentials.json"));
const trackerDirectory = join(root, "tracker");
const backend = createLocalTracker({
  directory: trackerDirectory,
  ...(runner ? { runner: () => ({ source: "proof host runner" }) } : {}),
});
// Times each backend call: with no contention this is the whole store-lock hold.
const tracker: typeof backend = {
  ...backend,
  async call(name, args, options) {
    const started = performance.now();
    try {
      return await backend.call(name, args, options);
    } finally {
      void log({
        event: "tracker.call",
        tool: name,
        ms: performance.now() - started,
        proofHooks: !!options?.onReadPrepared,
      });
    }
  },
};
if (process.argv.includes("--journal-records")) {
  if (!Number.isInteger(journalRecords) || journalRecords <= 0)
    throw new Error("Expected --journal-records N");
  const owner = JSON.stringify(["fleet", "default", "w0:seeded"]);
  const records = Array.from({ length: journalRecords }, (_, index) => ({
    id: randomUUID(),
    owner,
    server: "linear",
    tool: "get_issue",
    binding: "0".repeat(64),
    fingerprint: "1".repeat(64),
    createdAt: Date.now() - journalRecords + index,
    state: "settled",
    // The service keeps bodies for its newest 1,000 settled calls.
    ...(index >= journalRecords - 1_000
      ? { result: { outcome: "ok", content: "x".repeat(800), isError: false } }
      : {}),
  }));
  await mkdir(join(root, "worker-grants", "receipts"), { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, "worker-grants", "receipts", "connected-calls.json"),
    `${JSON.stringify(records)}\n`,
    {
      mode: 0o600,
    },
  );
}
// Initialize before any proved original: initialization itself is never READ.
const seeded = (await tracker.call("save_issue", {
  team: "LOCAL",
  title: "LOCAL-VUH-13 disposable READ receipt proof",
})) as { id: string; identifier: string };
const host = createMcpHost({
  trackerMcp: linearMcp,
  credentials,
  settings,
  curated: [],
  localTracker: tracker,
  trackerIdentity: trackerDirectory,
  logger: {
    info: (event: unknown) => void log({ event: "host.info", detail: event }),
    warn: (event: unknown) => void log({ event: "host.warn", detail: event }),
  },
});
const worker = new WorkerMcp({
  directory: join(root, "worker-grants"),
  credentials,
  host,
  fleetTools: async () => (await settings.load()).fleet.tools,
  fleetPeerMessages: async () => (await settings.load()).fleet.peerMessages,
  fleetToolsSnapshot: async () => {
    const snapshot = await settings.loadFenced();
    return { tools: snapshot.settings.fleet.tools, assertCurrent: snapshot.assertCurrent };
  },
});
const link = new LocalFleetLink({
  directory: join(root, "links"),
  binding,
  projectProof: localProjectProof({ binding, herdrBinary: "herdr", diagnostics }),
  prove: localFleetAdmissionProof({ binding, herdrBinary: "herdr", diagnostics }),
});
const server = serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: link.fetch(async (request) => {
    const identity = link.identity(request);
    if (new URL(request.url).pathname !== "/v1/fleet/mcp" || !identity)
      return Response.json({ error: "not_found" }, { status: 404 });
    return worker.handleLocalFleet(request, identity);
  }),
});
await new Promise<void>((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Missing proof host address");
if (address.port === 4310 || address.port === 4321) throw new Error("Refusing an installed service port");
await link.publish(address.port);
await writeFile(
  join(root, "host.json"),
  `${JSON.stringify({ pid: process.pid, port: address.port, runner, issue: seeded }, null, 2)}\n`,
  { mode: 0o600 },
);
await log({ event: "ready", port: address.port, runner, issue: seeded.identifier });
console.log(JSON.stringify({ ready: true, port: address.port, issue: seeded.identifier }));

await new Promise<void>((resolve) => {
  process.once("SIGTERM", resolve);
  process.once("SIGINT", resolve);
});
await link.close();
if ("closeAllConnections" in server) server.closeAllConnections();
await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
await log({ event: "closed" });
console.log("proof host closed");
