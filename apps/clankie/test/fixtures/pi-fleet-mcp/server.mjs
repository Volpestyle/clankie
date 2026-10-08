import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, appendFileSync } from "node:fs";
const [statePath, callsPath] = process.argv.slice(2);
appendFileSync(callsPath + ".starts", "start\n");
const state = () => JSON.parse(readFileSync(statePath, "utf8"));
const server = new Server(
  { name: "fleet-boundary-fixture", version: "1" },
  {
    capabilities: { tools: { listChanged: true } },
    instructions: "Fixture fleet tools keep native receipts.",
  },
);
server.setRequestHandler(ListToolsRequestSchema, (request) => {
  const tools = state().tools;
  const index = Number(request.params?.cursor ?? 0);
  return {
    tools: tools.slice(index, index + 1),
    ...(index + 1 < tools.length ? { nextCursor: String(index + 1) } : {}),
  };
});
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  appendFileSync(callsPath, JSON.stringify(request.params) + "\n");
  const selected = state();
  if (selected.hang) {
    await new Promise((resolve) => extra.signal.addEventListener("abort", resolve, { once: true }));
    return { content: [{ type: "text", text: "cancelled" }], isError: true };
  }
  if (!selected.allowed)
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ outcome: "refused", receiptId: "original-refusal", isError: true }),
        },
      ],
      isError: true,
      structuredContent: { outcome: "refused", receiptId: "original-refusal" },
    };
  return {
    content: [
      { type: "text", text: JSON.stringify(request.params.arguments) },
      { type: "image", mimeType: "image/png", data: "AA==" },
    ],
    structuredContent: { outcome: "uncertain", receiptId: "original-uncertain" },
    isError: false,
  };
});
await server.connect(new StdioServerTransport());
let previous = state().revision;
const timer = setInterval(() => {
  if (state().exit) {
    clearInterval(timer);
    void server.close();
    return;
  }
  const next = state().revision;
  if (next !== previous) {
    previous = next;
    void server.notification({ method: "notifications/tools/list_changed" }).catch(() => {});
  }
}, 25);
process.stdin.once("close", () => {
  clearInterval(timer);
  void server.close();
});
