import assert from "node:assert/strict";
import type { Server as HttpServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { readFile, writeFile, mkdtemp, rm, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { FleetSeatMessageSchema } from "@clankie/protocol";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { LocalFleetLink } from "../../../src/local-fleet-link.ts";
import { localFleetProof, localProjectProof } from "../../../src/local-fleet-proof.ts";
import { createMcpHost } from "../../../src/mcp-host.ts";
import { WorkerMcp } from "../../../src/worker-mcp.ts";
import { ConversationStore } from "../../../src/captain/conversations.ts";
import { InboundSeatReceipts } from "../../../src/captain/inbound-seat-receipts.ts";
import { parseHerdrAgentResult } from "../../../src/captain/herdr-watch.ts";
import { deliveryFingerprint } from "../../../src/captain/delivery-fence.ts";
import { isolatedHerdr } from "../local-fleet-proof/herdr-fixture.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const home = await mkdtemp("/tmp/clankie-proof-home-");
process.env.HOME = home;
const cleanup: Array<() => Promise<unknown>> = [() => rm(home, { recursive: true, force: true })];
try {
  const h = await isolatedHerdr("/tmp/linux-native-proof-logs");
  cleanup.push(h.close);
  const diagnostics: unknown[] = [];
  let linked = true;
  let reads = 0;
  const binding = { runtime: "external" as const, socketPath: h.socketPath, session: "default" };
  const prove = localFleetProof({
    herdrBinary: process.env.PROOF_HERDR!,
    processHelper: process.env.PROOF_HELPER!,
    binding: async () => (linked ? binding : undefined),
    diagnostics: (event) => diagnostics.push(event),
  });
  await mkdir(join(home, ".pi/agent/extensions"), { recursive: true });
  await promisify(execFile)(process.env.PROOF_HERDR!, ["integration", "install", "pi"]);
  const projectProof = localProjectProof({
    herdrBinary: process.env.PROOF_HERDR!,
    processHelper: process.env.PROOF_HELPER!,
    binding: async () => binding,
    diagnostics: (event) => diagnostics.push({ project: event }),
  });
  const link = new LocalFleetLink({
    directory: join(h.root, "state/links"),
    binding: async () => binding,
    prove,
    projectProof,
  });
  cleanup.push(() => link.close());
  const nativeBinding = async () => {
    const raw = await h.cli("agent", "get", h.pane);
    const agent = parseHerdrAgentResult(JSON.stringify(raw));
    assert.equal(agent.agent, "pi");
    assert.ok(agent.session, "Real Herdr Pi integration must report its native session");
    return deliveryFingerprint(JSON.stringify([agent.paneId, agent.terminalId, agent.agent, agent.session]));
  };
  const data = join(h.root, "data.txt");
  await writeFile(data, "owned Linux fixture data\n");
  const provider = new Server({ name: "proof", version: "1" }, { capabilities: { tools: {} } });
  provider.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "read",
        description: "Read the owned fixture file",
        inputSchema: { type: "object", additionalProperties: false },
      },
    ],
  }));
  provider.setRequestHandler(CallToolRequestSchema, async () => {
    reads++;
    return { content: [{ type: "text", text: await readFile(data, "utf8") }] };
  });
  cleanup.push(() => provider.close());
  const providerTransport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    enableJsonResponse: true,
  });
  await provider.connect(providerTransport);
  const providerHttp = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => providerTransport.handleRequest(request),
  });
  cleanup.push(async () => {
    (providerHttp as HttpServer).closeAllConnections();
    await new Promise<void>((resolve) => providerHttp.close(() => resolve()));
  });
  if (!providerHttp.listening) await new Promise<void>((resolve) => providerHttp.once("listening", resolve));
  const port = (providerHttp.address() as { port: number }).port;
  const credentials = new FileCredentialStore(join(h.root, "credentials.json"));
  await credentials.set("proof", {
    type: "api",
    key: "owned-fixture-only",
    account: {
      provider: "linear",
      actor: "app",
      connectionId: randomUUID(),
      userId: "fixture",
      workspaceId: "fixture",
      name: "Fixture",
      workspaceName: "Fixture",
      verifiedAt: new Date().toISOString(),
    },
  });
  const settings = new SettingsStore(join(h.root, "settings.json"));
  await settings.update((value) => ({
    ...value,
    mcp: {
      ...value.mcp,
      servers: [
        {
          id: "proof",
          credential: "proof",
          transport: "http",
          url: `http://127.0.0.1:${port}/mcp`,
          lane: "operator",
          args: [],
          initialTools: [],
          enabled: true,
        },
      ],
    },
  }));
  const host = createMcpHost({ settings, credentials, curated: [], logger: { info() {}, warn() {} } });
  cleanup.push(() => host.close());
  const worker = new WorkerMcp({
    directory: join(h.root, "grants"),
    credentials,
    host,
    fleetTools: async () => (await settings.load()).fleet.tools,
    fleetToolsSnapshot: async () => {
      const saved = await settings.loadFenced();
      return { tools: saved.settings.fleet.tools, assertCurrent: saved.assertCurrent };
    },
  });
  cleanup.push(() => worker.close());
  const conversations = new ConversationStore(join(h.root, "conversations"), async () => {
    throw new Error("No model turn in native kernel proof");
  });
  cleanup.push(() => conversations.close());
  const receipts = new InboundSeatReceipts(join(h.root, "receipts.json"), conversations);
  const received: string[] = [];
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: link.fetch(async (request) => {
      const identity = link.identity(request)!;
      const path = new URL(request.url).pathname;
      if (path === "/v1/fleet/mcp") return worker.handleLocalFleet(request, identity);
      if (path.endsWith("/messages/health")) return Response.json({ ok: true });
      if (path.endsWith("/events")) return Response.json({ events: [] });
      if (path.endsWith("/peers")) return Response.json({ enabled: false, seats: [] });
      if (path.endsWith("/messages") && request.method === "GET") {
        return Response.json({ schemaVersion: 1, binding: await nativeBinding() });
      }
      if (path.endsWith("/messages") && request.method === "POST") {
        const parsed = FleetSeatMessageSchema.parse(await request.json());
        assert.ok(parsed.delivery);
        assert.equal(parsed.delivery.binding, await nativeBinding());
        const receipt = receipts.accept(
          identity.pane,
          parsed.delivery,
          parsed.text,
          parsed.text,
          "global-default",
          async (_id, _message, _publish, context) => {
            context.deliveryReceipt?.("unavailable");
          },
          { source: "adoption", conversationId: "global-default" },
          { kind: "conversation", owner: { conversationId: "global-default" } },
        );
        if (receipt.received) received.push(parsed.text);
        return Response.json(receipt);
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    }),
  });
  cleanup.push(async () => {
    (server as HttpServer).closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address() as { port: number };
  await link.publish(address.port);
  const resultPath = join(h.root, "native-result.json");
  const command = [
    "env",
    `CLANKIE_STATE=${join(h.root, "state")}`,
    `PROOF_RESULT=${resultPath}`,
    `PROOF_FLEET_BRIDGE=${process.env.PROOF_FLEET_BRIDGE!}`,
    `HOME=${home}`,
    process.env.PROOF_PI!,
    "--extension",
    join(home, ".pi/agent/extensions/herdr-agent-state.ts"),
    "--extension",
    process.env.PROOF_EXTENSION!,
  ]
    .map(quote)
    .join(" ");
  await h.cli("pane", "run", h.pane, command);
  const deadline = Date.now() + 45_000;
  let result: Record<string, unknown> | undefined;
  while (Date.now() < deadline) {
    const raw = await readFile(resultPath, "utf8").catch(() => undefined);
    if (raw) {
      result = JSON.parse(raw);
      break;
    }
    await sleep(100);
  }
  assert.ok(result, "Native Pi TUI produced no result");
  assert.equal(result.error, undefined, JSON.stringify({ result, diagnostics }));
  assert.equal(result.mode, "tui");
  assert.equal(reads, 1);
  assert.deepEqual(received, ["Linux native Pi kernel proof complete"]);
  assert.equal(conversations.inboundReports().length, 1);
  // A same-user process outside the pane cannot impersonate the native worker,
  // even with its real pane and bridge identifier in forged request headers.
  const outsider = await fetch(
    `http://127.0.0.1:${address.port}/v1/fleet/seats/${encodeURIComponent(h.pane)}/messages`,
    {
      method: "POST",
      headers: { "x-clankie-pane": h.pane, "content-type": "application/json" },
      body: JSON.stringify({ text: "spoof", delivery: { id: randomUUID(), binding: "a".repeat(64) } }),
    },
  );
  assert.equal(outsider.status, 403);
  assert.equal(received.length, 1);
  linked = false;
  const revoked = await fetch(
    `http://127.0.0.1:${address.port}/v1/fleet/seats/${encodeURIComponent(h.pane)}/messages`,
    {
      method: "POST",
      headers: { "x-clankie-pane": h.pane },
      body: "{}",
    },
  );
  assert.equal(revoked.status, 403);
  console.log(
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        uid: process.getuid?.(),
        native: result,
        reads,
        retainedReports: conversations.inboundReports().length,
        outsiderStatus: outsider.status,
        revokedStatus: revoked.status,
        diagnostics,
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all(cleanup.reverse().map(async (close) => close()));
}
