import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CONNECTOR_GRANTS } from "../../../packages/protocol/src/index.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { expect, it } from "vitest";
import { ClankieGuide } from "../src/connector-guide.ts";
import { LeadStore } from "../../clankie/src/captain/lead.ts";
import { createConnectorMcpHandler } from "../src/connector-mcp.ts";

it("budgets escaped JSON, preserves unread report discovery and caps short-item pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "connector-inbox-"));
  const store = new LeadStore(join(root, "lead.json"), join(root, "held.json"));
  store.set("apps");
  // Maximum report-thread count with long IDs, plus text whose JSON encoding
  // expands sixfold. Raw string lengths alone cannot bound this response.
  const reports = Array.from({ length: 256 }, (_, index) => ({
    conversationId: `${index}-${"r".repeat(500)}`,
    count: 1,
  }));
  for (let index = 0; index < 60; index++)
    store.hold({ conversationId: "global-default", origin: "wake", text: "\u0001".repeat(16_000) });
  const handler = createConnectorMcpHandler({
    version: "test",
    localAuthorizationServer: "http://127.0.0.1",
    guide: new ClankieGuide(resolve(import.meta.dirname, "../../..")),
    authorizeDevice: {
      authorize: async () => ({
        authorized: true,
        device: {
          deviceId: "inbox-app",
          sessionExpiresAt: "2099-01-01T00:00:00.000Z",
          name: "Claude",
          platform: "unknown",
          scope: "connector",
          grants: CONNECTOR_GRANTS,
          host: { name: "Test Mac" },
        },
      }),
    },
    operator: {
      dispatch: async (request) => {
        if (request.op !== "lead" || request.command.action !== "inbox")
          throw new Error("Unexpected operation");
        const page = store.inbox(request.command.after, request.command.limit);
        return {
          op: "lead",
          schemaVersion: 1,
          result: {
            status: store.status(),
            ...page,
            unreadReports: reports,
          },
        };
      },
      terminalTail: async () => {
        throw new Error("Unexpected tail");
      },
    },
  });
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  const client = new Client({ name: "inbox-test", version: "1" });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`),
        { requestInit: { headers: { authorization: "Bearer test" } } },
      ) as unknown as Transport,
    );
    const call = async (args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name: "read_inbox", arguments: args });
      expect(result.isError).not.toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      expect(text.length).toBeLessThanOrEqual(24_000);
      return JSON.parse(text);
    };
    let page = await call();
    expect(Object.keys(page)[0]).toBe("unreadReports");
    expect(page.unreadReports[0]).toEqual(reports[0]);
    const seen = [...page.unreadReports];
    while (page.nextReportsAfter !== undefined) {
      page = await call({ reportsAfter: page.nextReportsAfter });
      seen.push(...page.unreadReports);
    }
    expect(seen).toEqual(reports);
    const preview = page.held[0];
    const chunk = await call(preview.readMore);
    expect(chunk.text).toBe("\u0001".repeat(2_000));
    expect(chunk.readMore).toEqual({ item: preview.seq, offset: 2_800 });
    // Short texts still obey the original item-count and after cursor contract.
    reports.splice(0);
    for (let index = 0; index < 60; index++)
      store.hold({ conversationId: "global-default", origin: "wake", text: "short" });
    page = await call({ after: 60 });
    expect(page.held).toHaveLength(50);
    expect(page.next).toBe(110);
    expect(page.more).toBe(true);
    expect((await call({ after: page.next })).held).toHaveLength(10);
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
