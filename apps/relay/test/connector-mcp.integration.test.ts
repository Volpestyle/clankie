import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CONNECTOR_GRANTS,
  defaultOperatorAgentAppearance,
  type OperatorConversationServiceRequest,
  type OperatorConversationServiceResult,
} from "../../../packages/protocol/src/index.ts";
import { createConnectorMcpHandler, createLoopbackConnectorOperator } from "../src/connector-mcp.ts";
import type { RelayDeviceAuthorization } from "../src/device-auth.ts";
import { createOperatorConversationRelayHandler } from "../src/operator-conversations.ts";

// Real HTTP end to end on the relay: the MCP SDK's own client talks to /mcp,
// whose tools call back into this relay's /operator/v1 boundary with the
// connector's bearer, so the allowlist is the one a hand-built request meets.
// The captain behind the relay is a recording stand-in.

const CONNECTOR_TOKEN = "connector-device-session-token";
const NOW = "2026-10-29T12:00:00.000Z";
const connectorDevice = {
  deviceId: "device-connector-1",
  name: "Claude",
  platform: "unknown" as const,
  grants: CONNECTOR_GRANTS,
  scope: "connector" as const,
  host: { name: "Work Mac" },
  sessionExpiresAt: "2026-10-29T13:00:00.000Z",
};
const persona = (personaId: string, name: string) => ({
  schemaVersion: 1 as const,
  personaId,
  name,
  appearance: defaultOperatorAgentAppearance("claude", personaId),
  harness: "claude",
  createdAt: NOW,
  updatedAt: NOW,
});
const thread = (
  conversationId: string,
  scope: Extract<OperatorConversationServiceRequest, { op: "create" }>["scope"],
  revision = 3,
) => ({
  schemaVersion: 1 as const,
  conversationId,
  scope,
  title: "Thread",
  isDefault: false,
  createdAt: NOW,
  updatedAt: NOW,
  sessionState: "active" as const,
  revision,
});
// A full Herdr redraw: home, write, move, overwrite part of a line, erase the rest.
const SCREEN =
  "\u001b[2J\u001b[H\u001b[1mBuilding kh2\u001b[0m\r\n\u001b[32m> cargo build\u001b[0m\r\n\u001b[3;1HCompiling...  ok\u001b[3;13Hdone\u001b[K";

const HISTORY = Array.from({ length: 10 }, (_, index) => `\u001b[2mline ${index + 1}\u001b[0m\r\n`).join("");

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    }),
  );
});

async function startConnectorRelay(
  device: RelayDeviceAuthorization = { authorized: true, device: connectorDevice },
) {
  const seen: OperatorConversationServiceRequest[] = [];
  const authorizeDevice = { authorize: async () => device };
  let selfUrl = "";
  const dispatch = async (
    request: OperatorConversationServiceRequest,
  ): Promise<OperatorConversationServiceResult> => {
    seen.push(request);
    switch (request.op) {
      case "fleet":
        return {
          op: "fleet",
          schemaVersion: 1,
          snapshot: {
            schemaVersion: 1,
            cursor: "c1",
            seats: [
              {
                seatId: "seat-kh2",
                occupantId: "occ-1",
                personaId: "p-bram",
                harness: "claude",
                status: "working",
                title: "kh2 netcode",
                workingDirectory: "C:\\code\\kh2",
                machine: "PC1",
                fleet: "pc1",
              },
            ],
            personas: [persona("p-bram", "Bram")],
            channels: [],
          },
        };
      case "terminal_catalog":
        return {
          op: "terminal_catalog",
          schemaVersion: 1,
          sessions: [
            {
              terminalId: "seat-kh2",
              label: "kh2",
              workspace: { id: "w1", label: "kh2", number: 1 },
              tab: { id: "t1", label: "main", number: 1 },
              pane: { id: "p1" },
              agent: "claude",
            },
            {
              terminalId: "term-loose",
              label: "scratch",
              workspace: { id: "w1", label: "kh2", number: 1 },
              tab: { id: "t2", label: "scratch", number: 2 },
              pane: { id: "p2" },
              agent: "codex",
            },
          ],
        };
      case "create":
        return { op: "create", schemaVersion: 1, conversation: thread("conv-bram", request.scope) };
      case "get":
        return {
          op: "get",
          schemaVersion: 1,
          conversation:
            request.conversationId === "conv-bram"
              ? thread("conv-bram", { kind: "persona", personaId: "p-bram" })
              : thread(request.conversationId, { kind: "global" }),
        };
      case "send":
        return {
          op: "send",
          schemaVersion: 1,
          result: {
            schemaVersion: 1,
            status: "accepted",
            conversationId: request.turn.conversationId,
            runId: "run-1",
            revision: request.turn.expectedRevision + 1,
            safeCursor: "c2",
            ...(request.turn.message === "after your goal"
              ? { seatDelivery: { state: "queued" as const, detail: "Bram is mid-goal; the message waits." } }
              : {}),
          },
        } as OperatorConversationServiceResult;
      case "terminal_tail":
        return {
          op: "terminal_tail",
          schemaVersion: 1,
          result: {
            schemaVersion: 1,
            status: "page",
            terminalId: request.observation.terminalId,
            surfaceClientId: request.observation.surfaceClientId,
            cursor: { streamId: "s1", sequence: 1 },
            frames: [
              {
                schemaVersion: 1,
                type: "terminal.frame",
                terminalId: request.observation.terminalId,
                sequence: 1,
                encoding: "base64",
                // The service seeds a pane's existing history ahead of its first redraw.
                data: Buffer.from(
                  request.observation.terminalId === "term-loose" ? `${HISTORY}${SCREEN}` : SCREEN,
                ).toString("base64"),
                columns: 40,
                rows: 6,
                full: true,
              },
            ],
            hasMore: false,
          },
        };
      default:
        throw new Error(`unexpected ${request.op}`);
    }
  };
  const operator = createOperatorConversationRelayHandler({ authorizeDevice, dispatch, tailPollMs: 50 });
  const connector = createConnectorMcpHandler({
    authorizeDevice,
    operator: createLoopbackConnectorOperator("http://placeholder.invalid", (input, init) =>
      fetch(new URL(new URL(String(input)).pathname, selfUrl), init),
    ),
    localAuthorizationServer: "http://127.0.0.1:4310",
    version: "test",
  });
  const server = createServer((request, response) => {
    void (async () => {
      if (await connector(request, response)) return;
      if (await operator(request, response)) return;
      response.statusCode = 404;
      response.end();
    })();
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");
  selfUrl = `http://127.0.0.1:${address.port}`;
  return { url: selfUrl, seen };
}

async function connect(url: string, token = CONNECTOR_TOKEN) {
  const client = new Client({ name: "connector-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/mcp", url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }) as unknown as Transport,
  );
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const [first] = result.content as Array<{ type: string; text: string }>;
  return first!.text;
}

describe("Claude connector MCP endpoint", () => {
  it("lists agents with their machine, reads a pane as text, and messages the agent's persona thread", async () => {
    const relay = await startConnectorRelay();
    const client = await connect(relay.url);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(["list_agents", "read_agent", "message_agent"]);

    const listed = JSON.parse(textOf(await client.callTool({ name: "list_agents", arguments: {} })));
    expect(listed).toEqual({
      agents: [
        {
          agent: "herdr:seat-kh2",
          name: "Bram",
          harness: "claude",
          machine: "PC1",
          project: "kh2",
          workingDirectory: "C:\\code\\kh2",
          status: "working",
          title: "kh2 netcode",
          canMessage: true,
        },
        {
          agent: "herdr:term-loose",
          harness: "codex",
          machine: "this Mac",
          title: "scratch",
          canMessage: false,
        },
      ],
      machines: ["PC1", "this Mac"],
    });

    const read = JSON.parse(
      textOf(await client.callTool({ name: "read_agent", arguments: { agent: "herdr:seat-kh2" } })),
    );
    expect(read).toEqual({ agent: "herdr:seat-kh2", text: "Building kh2\n> cargo build\nCompiling...done" });
    // History that scrolled off before the first redraw is still read.
    const loose = JSON.parse(
      textOf(
        await client.callTool({ name: "read_agent", arguments: { agent: "herdr:term-loose", lines: 5 } }),
      ),
    );
    expect(loose.text).toBe("line 4\nline 5\nBuilding kh2\n> cargo build\nCompiling...done");

    const sent = JSON.parse(
      textOf(
        await client.callTool({
          name: "message_agent",
          arguments: { agent: "herdr:seat-kh2", message: "run the tests" },
        }),
      ),
    );
    expect(sent).toMatchObject({ agent: "herdr:seat-kh2", status: "delivered" });
    const queued = JSON.parse(
      textOf(
        await client.callTool({
          name: "message_agent",
          arguments: { agent: "herdr:seat-kh2", message: "after your goal" },
        }),
      ),
    );
    expect(queued).toEqual({
      agent: "herdr:seat-kh2",
      status: "queued",
      detail: "Bram is mid-goal; the message waits.",
    });
    const send = relay.seen.find((request) => request.op === "send");
    expect(send).toMatchObject({
      turn: {
        conversationId: "conv-bram",
        expectedRevision: 3,
        message: "run the tests",
        surfaceClientId: "claude-connector",
      },
    });
    expect(relay.seen.find((request) => request.op === "create")).toMatchObject({
      scope: { kind: "persona", personaId: "p-bram" },
    });
    await client.close();
  });

  it("refuses everything outside the allowlist, including Clankie's own thread, by hand-built request", async () => {
    const relay = await startConnectorRelay();
    const post = (path: string, body: unknown) =>
      fetch(new URL(path, relay.url), {
        method: "POST",
        headers: { authorization: `Bearer ${CONNECTOR_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    for (const body of [
      {
        op: "terminal_input",
        schemaVersion: 1,
        input: { schemaVersion: 1, terminalId: "seat-kh2", leaseToken: "x", data: "aGk=" },
      },
      { op: "spawn_seat", schemaVersion: 1, seat: { harness: "claude", workingDirectory: "/tmp" } },
      { op: "close_seat", schemaVersion: 1, seatId: "seat-kh2" },
      { op: "autonomy", schemaVersion: 1, command: { action: "status" } },
      { op: "work_item_write", schemaVersion: 1 },
      { op: "list", schemaVersion: 1 },
      { op: "create", schemaVersion: 1, scope: { kind: "global" }, title: "Clankie" },
    ]) {
      const response = await post("/operator/v1/dispatch", body);
      expect([400, 403], JSON.stringify(body)).toContain(response.status);
      if (response.status === 403)
        expect(await response.json()).toEqual({ error: "connector_operation_not_allowed" });
    }
    const lead = await post("/operator/v1/dispatch", {
      op: "send",
      schemaVersion: 1,
      turn: {
        schemaVersion: 1,
        conversationId: "global-default",
        surfaceClientId: "claude-connector",
        expectedRevision: 0,
        kind: "message",
        message: "do something on the Mac",
      },
    });
    expect(lead.status).toBe(403);
    expect(relay.seen.some((request) => request.op === "send")).toBe(false);
    for (const path of ["/operator/v1/tail", "/v1/body-leases", "/v1/operator/http-settings"]) {
      const response = await fetch(new URL(path, relay.url), {
        method: path === "/v1/body-leases" || path === "/v1/operator/http-settings" ? "GET" : "POST",
        headers: { authorization: `Bearer ${CONNECTOR_TOKEN}`, "content-type": "application/json" },
        ...(path === "/operator/v1/tail" ? { body: "{}" } : {}),
      });
      expect(response.status, path).toBe(403);
    }
  });

  it("answers without a bearer with the 401 that starts Claude's sign-in, and serves the resource metadata", async () => {
    const relay = await startConnectorRelay();
    const response = await fetch(new URL("/mcp", relay.url), { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    const host = new URL(relay.url).host;
    expect(response.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="http://${host}/.well-known/oauth-protected-resource/mcp", scope="agents offline_access"`,
    );
    const metadata = await fetch(new URL("/.well-known/oauth-protected-resource/mcp", relay.url));
    expect(await metadata.json()).toMatchObject({
      resource: `http://${host}/mcp`,
      authorization_servers: ["http://127.0.0.1:4310"],
    });
    const forwarded = await fetch(new URL("/.well-known/oauth-protected-resource/mcp", relay.url), {
      headers: { "x-clankie-public-base": "https://api.clankie.bot/h/host-example-123456" },
    });
    expect(await forwarded.json()).toMatchObject({
      resource: "https://api.clankie.bot/h/host-example-123456/mcp",
      authorization_servers: ["https://api.clankie.bot/h/host-example-123456"],
    });
  });

  it("asks for a fresh sign-in once the device is revoked, and refuses a device that isn't a connector", async () => {
    const revoked = await startConnectorRelay({ authorized: false, denial: "revoked" });
    const response = await fetch(new URL("/mcp", revoked.url), {
      method: "POST",
      headers: { authorization: `Bearer ${CONNECTOR_TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    const phone = await startConnectorRelay({
      authorized: true,
      device: {
        ...connectorDevice,
        scope: undefined,
        grants: { ...CONNECTOR_GRANTS, terminalControl: true },
      } as never,
    });
    const refused = await fetch(new URL("/mcp", phone.url), {
      method: "POST",
      headers: { authorization: `Bearer ${CONNECTOR_TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(refused.status).toBe(403);
  });
});
