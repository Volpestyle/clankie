import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { serve } from "@hono/node-server";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { expect, it } from "vitest";
import { LocalFleetLink, type LocalFleetProofRequestContext } from "../src/local-fleet-link.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { linearMcp } from "../src/linear-mcp.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;
const requestTimeoutMs = 250;
// Each request's deadline timers (its budget and the 2 s plugin-notice wait)
// hold their signals until they fire; that is bounded by time, not by calls.
const settle = async () => {
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  for (let pass = 0; pass < 3; pass++) {
    await new Promise((resolve) => setImmediate(resolve));
    gc();
  }
};

// VUH-2216: a parked worker bridge keeps one MCP session for hours and calls it
// every few seconds. Each answered request must release its HTTP request,
// socket attribution and admission closures, or the service grows ~1.5 GB/h.
it("releases every answered request on a long-lived fleet MCP session", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-worker-mcp-memory-"));
  const settings = new SettingsStore(join(root, "settings.json"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const host = createMcpHost({
    trackerMcp: linearMcp,
    settings,
    credentials,
    curated: [],
    logger: { info() {}, warn() {} },
  });
  const worker = new WorkerMcp({ directory: join(root, "grants"), credentials, host, requestTimeoutMs });
  const contexts: WeakRef<LocalFleetProofRequestContext>[] = [];
  const local = new LocalFleetLink({
    directory: join(root, "links"),
    binding: async () => undefined,
    // Admission is not under test; every request still crosses this real boundary.
    prove: async (socket, pane, _signal, context) => {
      if (context) contexts.push(new WeakRef(context));
      return pane === "w1:p1" && !socket.destroyed;
    },
  });
  const listener = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: local.fetch(async (request) => {
      const identity = local.identity(request);
      return identity
        ? worker.handleLocalFleet(request, identity)
        : Response.json({ error: "missing_identity" }, { status: 403 });
    }),
  });
  try {
    await new Promise<void>((resolve) =>
      listener.listening ? resolve() : listener.once("listening", resolve),
    );
    const address = listener.address();
    if (!address || typeof address === "string") throw new Error("Missing local listener");
    const endpoint = `http://127.0.0.1:${address.port}/v1/fleet/mcp`;
    const bridgeId = randomUUID();
    let id = 0;
    let session: string | undefined;
    const rpc = async (method: string, params: unknown = {}) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "x-clankie-pane": "w1:p1",
          "x-clankie-bridge-id": bridgeId,
          ...(session === undefined
            ? {}
            : { "mcp-session-id": session, "mcp-protocol-version": "2025-06-18" }),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      });
      const body = (await response.json()) as { result?: { tools?: unknown[] } };
      expect(response.status).toBe(200);
      session ??= response.headers.get("mcp-session-id") ?? undefined;
      return body;
    };
    await rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "memory-fixture", version: "1" },
    });
    expect(session).toBeDefined();
    const calls = async (count: number) => {
      for (let call = 0; call < count; call++)
        expect((await rpc("tools/list")).result?.tools).toBeInstanceOf(Array);
    };

    await calls(50);
    await settle();
    const before = process.memoryUsage().heapUsed;
    await calls(1000);
    await settle();
    const grown = process.memoryUsage().heapUsed - before;

    // Every request crossed admission on the same session.
    expect(contexts.length).toBe(1051);
    // Only the latest request's attribution may still be reachable.
    expect(contexts.filter((context) => context.deref() !== undefined).length).toBeLessThanOrEqual(1);
    // Leaking, these 1000 calls retained ~20 MB; released, the heap stays flat.
    expect(grown).toBeLessThan(6 * 1024 * 1024);
  } finally {
    await worker.close();
    await host.close();
    await new Promise<void>((resolve, reject) => {
      listener.close((error) => (error ? reject(error) : resolve()));
      if ("closeAllConnections" in listener) listener.closeAllConnections();
    });
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
