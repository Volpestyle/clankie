/** Standalone remote operator plugin entry; bundled with only Node dependencies. */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { connectLaneUpstream, createSeatBridge, pumpSeatEvents } from "../src/command/mcp.ts";
import { runSeatSyncCommand } from "../src/command/seat-sync.ts";

const token = process.env.CLANKIE_REMOTE_LEAD_TOKEN;
delete process.env.CLANKIE_REMOTE_LEAD_TOKEN;
const pane = process.env.HERDR_PANE_ID;
const fleet = process.env.CLANKIE_REMOTE_LEAD_FLEET;
const conversationId = process.env.CLANKIE_CONVERSATION_ID;
if (!token || !pane || !fleet || !conversationId) throw new Error("Remote lead launch binding missing");
const closing = new AbortController();
const request: typeof fetch = async (resource, init) => {
  const original = new Request(resource, init);
  const link = JSON.parse(await readFile(join(homedir(), ".clankie", "links", `${fleet}.json`), "utf8"));
  const target = new URL(original.url);
  const address = new URL(link.url);
  if (link.schemaVersion !== 2 || link.authentication !== "local-process" || link.fleet !== fleet ||
      address.protocol !== "http:" || address.hostname !== "127.0.0.1")
    throw new Error("Authenticated fleet relay unavailable");
  if (target.pathname === "/v1/mcp") target.pathname = "/v1/fleet/lead/mcp";
  else if (target.pathname.startsWith("/v1/seat/events"))
    target.pathname = target.pathname.replace("/v1/seat/events", "/v1/fleet/lead/events");
  else if (target.pathname === "/v1/seat/transcript") target.pathname = "/v1/fleet/lead/transcript";
  else if (target.pathname !== "/v1/fleet/lead/prompt") throw new Error("Remote lead route unavailable");
  target.host = address.host;
  const headers = new Headers(original.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("x-clankie-pane", pane);
  const response = await fetch(target, {
    method: original.method, headers, redirect: "error",
    ...(original.body ? { body: await original.arrayBuffer() } : {}),
    signal: AbortSignal.any([original.signal, closing.signal]),
  });
  if (response.status === 403) closing.abort();
  return response;
};
if (process.argv.includes("--sync")) {
  await runSeatSyncCommand([], {
    env: { ...process.env, CLANKIE_OPERATOR_TOKEN: token },
    host: "http://127.0.0.1", fetchImpl: request,
  });
} else if (process.argv.includes("--prompt")) {
  const response = await request("http://127.0.0.1/v1/fleet/lead/prompt");
  if (!response.ok) throw new Error("Remote lead prompt unavailable");
  process.stdout.write(await response.text());
} else {
  const upstream = await connectLaneUpstream({
    host: "http://127.0.0.1", bearer: token, conversationId, fetchImpl: request,
  });
  const server = createSeatBridge(upstream, "operator");
  server.onclose = () => closing.abort();
  await server.connect(new StdioServerTransport());
  await pumpSeatEvents(server, upstream, closing.signal);
  await upstream.close();
  await server.close();
}
