import { writeFileSync } from "node:fs";

const options = JSON.parse(process.argv[2] ?? "{}");
let buffer = "";
let activeCalls = 0;
let maxActiveCalls = 0;

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

async function handle(message) {
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "fake-browser", version: "1" },
    });
    return;
  }
  if (message.method === "tools/list") {
    const page = Number(message.params?.cursor ?? "0");
    const pages = options.toolPages ?? [options.tools ?? []];
    reply(message.id, {
      tools: pages[page] ?? [],
      ...(page + 1 < pages.length ? { nextCursor: String(page + 1) } : {}),
    });
    return;
  }
  if (message.method === "tools/call") {
    activeCalls += 1;
    maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
    if (options.callDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.callDelayMs));
    }
    activeCalls -= 1;
    if (options.statsPath) writeFileSync(options.statsPath, JSON.stringify({ maxActiveCalls }));
    reply(message.id, options.callResult ?? { content: [{ type: "text", text: "ok" }] });
  }
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (line) void handle(JSON.parse(line));
  }
});
