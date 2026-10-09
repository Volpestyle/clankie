import { describe, expect, test } from "vitest";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createRemoteLeadBridge } from "../src/remote-lead-bridge.ts";
import { RemoteLeadDelegations } from "../src/remote-lead-delegations.ts";
import { occupantIdForHerdrSession } from "../src/captain/herdr-census.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { fleetLinkFetch } from "../src/fleet-link.ts";
import { assertConversationAuthority } from "../src/captain/conversation-owner.ts";
import { createBearerAuthenticator } from "../src/app/http-auth.ts";

// Host-proof fixtures delimit this HTTP/MCP contract test. Native observation
// and real hire adoption require the separate, deployed Windows live proof.
const nativeSession = "6487aff1-13e8-4bb7-8301-1588cb5d9db2";
const binding = {
  fleet: "pc",
  machine: "pc",
  pane: "w1:p1",
  conversationId: "conv-project",
  nativeOccupantId: occupantIdForHerdrSession({ source: "herdr:claude", kind: "id", value: nativeSession }),
  workingDirectory: "C:\\scratch",
  connectionKey: "connection",
  shell: { pid: 123, startTime: "2026-10-09T00:00:00.0000000Z" },
};
const identity = {
  fleet: "pc",
  pane: "w1:p1",
  current: () => true,
  validate: async () => true,
  projectProof: async () => ({
    ...binding,
    binding: { socketPath: "pipe", session: "default" },
    workspace: { machineId: "pc", platform: "windows" as const, canonicalPath: binding.workingDirectory },
    processes: [{ pid: 456, startTime: "2026-10-09T00:00:01.0000000Z" }],
  }),
};

describe("remote lead HTTP/MCP trust boundary", () => {
  test("binds chat/session, excludes owner routes and refuses revoked calls on an existing MCP session", async () => {
    const grants = new RemoteLeadDelegations(async () => {});
    const issued = await grants.issue(binding);
    let effects = 0;
    let held = false;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bridge = createRemoteLeadBridge({
      delegations: grants,
      identity: () => identity,
      captain: createStubCaptain({
        syncSeatTranscript: (conversationId, transcript) => {
          expect(conversationId).toBe(binding.conversationId);
          expect(transcript.sessionId).toBe(nativeSession);
          return true;
        },
        laneToolBank: async (_lane, conversationId, authority) => {
          expect(conversationId).toBe(binding.conversationId);
          expect(authority?.owner.conversationId).toBe(binding.conversationId);
          return {
            lane: _lane,
            tools: ["hire_agent", "owner_settings"].map((name) => ({
              name,
              description: name,
              inputSchema: { type: "object", properties: {} },
              call: async () => {
                if (held) {
                  enter();
                  await resume;
                }
                await assertConversationAuthority(authority!);
                effects++;
                return { content: [{ type: "text" as const, text: "accepted" }] };
              },
            })),
          };
        },
      }),
    });
    const headers = { authorization: `Bearer ${issued.token}` };
    const request = (path: string, init?: RequestInit) => bridge.app.request(path, { headers, ...init });
    const client = new Client({ name: "trust-boundary", version: "1" });
    try {
      expect((await request("/v1/fleet/lead/mcp?conversationId=conv-other")).status).toBe(403);
      expect(
        (
          await request("/v1/fleet/lead/transcript", {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ sessionId: "22c7c3a3-f024-4764-afc6-cc58e3a4f54e", entries: [] }),
          })
        ).status,
      ).toBe(403);
      expect(
        (await request("/v1/fleet/lead/mcp", { headers: { authorization: "Bearer worker-token" } })).status,
      ).toBe(403);
      expect(
        (
          await request("/v1/fleet/lead/transcript", {
            method: "POST",
            headers: { ...headers, "content-type": "application/json" },
            body: JSON.stringify({ sessionId: nativeSession, entries: [] }),
          })
        ).status,
      ).toBe(200);
      const owner = createBearerAuthenticator("separate-owner-secret", { operatorId: "owner" });
      expect(await owner(new Request("http://service/v1/remote-leads/revoke", { headers }))).toBeUndefined();
      expect(
        (
          await fleetLinkFetch((request) => bridge.app.fetch(request))(
            new Request("http://service/v1/remote-leads/revoke", { method: "POST", headers }),
          )
        ).status,
      ).toBe(404);
      await client.connect(
        new StreamableHTTPClientTransport(new URL("http://service/v1/fleet/lead/mcp"), {
          requestInit: { headers },
          fetch: async (input, init) => bridge.app.fetch(new Request(input, init)),
        }) as unknown as Transport,
      );
      const catalog = await client.listTools();
      expect(catalog.tools.map((tool) => tool.name)).toContain("hire_agent");
      expect(catalog.tools.map((tool) => tool.name)).not.toContain("owner_settings");
      expect((await client.callTool({ name: "hire_agent", arguments: {} })).isError).not.toBe(true);
      expect(effects).toBe(1);
      held = true;
      const queued = client.callTool({ name: "hire_agent", arguments: {} }).catch(() => undefined);
      await entered;
      grants.revoke(issued.id);
      release();
      await queued;
      await expect(client.callTool({ name: "hire_agent", arguments: {} })).rejects.toThrow();
      expect(effects).toBe(1);
    } finally {
      await client.close();
      await bridge.close();
    }
  });
});
