#!/usr/bin/env node
// Call a connected service's MCP tools through a Clankie worker grant.
//   node call-grant.mjs GRANT.json --list
//   node call-grant.mjs GRANT.json linear_list_issues '{"project":"Clankie","query":"x"}'
// GRANT.json comes from `clankie access issue REQUEST.json --out GRANT.json` (mode 0600).
// The token is never printed.
import { readFileSync } from "node:fs";

const [grantPath, tool, rawArgs] = process.argv.slice(2);
if (!grantPath || !tool) {
  console.error("usage: call-grant.mjs GRANT.json (--list | TOOL ['{json args}'])");
  process.exit(2);
}
const grant = JSON.parse(readFileSync(grantPath, "utf8"));
const headers = {
  authorization: `Bearer ${grant.token}`,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

async function rpc(body, session) {
  const response = await fetch(grant.endpoint, {
    method: "POST",
    headers: { ...headers, ...(session ? { "mcp-session-id": session } : {}) },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  // Streamable HTTP answers either JSON or one SSE event.
  const data = text.includes("data:")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .pop()
        .slice(5)
    : text;
  return {
    session: response.headers.get("mcp-session-id") ?? session,
    status: response.status,
    json: data ? JSON.parse(data) : null,
  };
}

const init = await rpc({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "clankie-linear-mcp", version: "1" },
  },
});
if (init.status >= 400) {
  console.error(`initialize failed (${init.status}): ${JSON.stringify(init.json)}`);
  process.exit(1);
}
await rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, init.session);
const call =
  tool === "--list"
    ? { jsonrpc: "2.0", id: 2, method: "tools/list" }
    : {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: tool, arguments: JSON.parse(rawArgs ?? "{}") },
      };
const result = await rpc(call, init.session);
if (result.json?.error) {
  console.error(JSON.stringify(result.json.error));
  process.exit(1);
}
const payload = result.json?.result;
if (tool === "--list") console.log(payload.tools.map((entry) => entry.name).join("\n"));
else {
  for (const part of payload?.content ?? []) console.log(part.text ?? JSON.stringify(part));
  if (payload?.isError) process.exit(1);
}
