// A throwaway instance of the real /v1/work route and work_* dispatch ops, so
// the proof exercises `clankie work` end to end without restarting the owner's
// running service. Linear goes through Clankie's connected account over MCP,
// exactly as the service's MCP host does; GitHub through the owner's gh.
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createDefaultCredentialStore, resolveProviderBearer } from "@clankie/credential-broker";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createClankieApp } from "../../../../apps/clankie/src/app.ts";
import { createStubCaptain } from "../../../../apps/clankie/src/captain/port.ts";
import { createWorkItemsService } from "../../../../apps/clankie/src/work-items.ts";

const token = process.env.CLANKIE_OPERATOR_TOKEN;
const port = Number(process.env.PORT ?? "4399");
if (token === undefined) throw new Error("set CLANKIE_OPERATOR_TOKEN");

const bearer = await resolveProviderBearer("linear", createDefaultCredentialStore({ env: process.env }));
const linear = new Client({ name: "work-items-proof", version: "0" });
await linear.connect(
  new StreamableHTTPClientTransport(new URL("https://mcp.linear.app/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  }),
);

const workItems = createWorkItemsService({
  stateDirectory: await mkdtemp(join(tmpdir(), "work-proof-state-")),
  workspace: () => process.env.WORKSPACE ?? process.cwd(),
  mcpHost: {
    async call(input) {
      const result = await linear.callTool({ name: input.tool, arguments: input.arguments });
      const text = (result.content as { type: string; text?: string }[])
        .map((part) => part.text ?? "")
        .join("");
      return { outcome: "ok", content: text, isError: result.isError === true };
    },
  },
});
const { app } = await createClankieApp({
  captain: createStubCaptain(),
  workItems,
  authenticateOperator: async (request) =>
    request.headers.get("authorization") === `Bearer ${token}` ? { operatorId: "proof" } : undefined,
  authenticateCaptain: async (request) =>
    request.headers.get("authorization") === `Bearer ${token}`
      ? { captainId: "device", steerSourceLane: "api" }
      : undefined,
});
serve({ fetch: app.fetch, hostname: "127.0.0.1", port });
console.log(`work-items proof service on http://127.0.0.1:${String(port)}`);
