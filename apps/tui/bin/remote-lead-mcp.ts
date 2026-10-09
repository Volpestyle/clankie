/** Standalone remote operator plugin entry; bundled with only Node dependencies. */
// Initialize the shared Zod entry before SDK schemas. Otherwise esbuild's
// wrapped protocol imports can leave ZodCustom uninitialized at SDK startup.
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
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
const binding = z
  .object({
    token: z.string().min(1),
    pane: z.string().min(1),
    fleet: z.string().min(1),
    conversationId: z.string().min(1),
  })
  .safeParse({ token, pane, fleet, conversationId });
if (!token || !pane || !fleet || !conversationId || !binding.success)
  throw new Error("Remote lead launch binding missing");
const closing = new AbortController();
const request: typeof fetch = async (resource, init) => {
  const original = new Request(resource, init);
  const link = JSON.parse(await readFile(join(homedir(), ".clankie", "links", `${fleet}.json`), "utf8"));
  const target = new URL(original.url);
  const address = new URL(link.url);
  if (
    link.schemaVersion !== 2 ||
    link.authentication !== "local-process" ||
    link.fleet !== fleet ||
    address.protocol !== "http:" ||
    address.hostname !== "127.0.0.1"
  )
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
    method: original.method,
    headers,
    redirect: "error",
    ...(original.body ? { body: await original.arrayBuffer() } : {}),
    signal: AbortSignal.any([original.signal, closing.signal]),
  });
  if (response.status === 403) {
    const reason: unknown = await response
      .clone()
      .json()
      .catch(() => undefined);
    if (
      typeof reason === "object" &&
      reason !== null &&
      "error" in reason &&
      reason.error === "remote_lead_revoked"
    ) {
      closing.abort();
      throw new Error("Remote lead delegation explicitly revoked");
    }
    // A native observation or policy read can be temporarily unavailable.
    // Refusal still blocks this request; it does not end the native bridge.
  }
  return response;
};
if (process.argv.includes("--sync")) {
  await runSeatSyncCommand([], {
    env: { ...process.env, CLANKIE_OPERATOR_TOKEN: token },
    host: "http://127.0.0.1",
    fetchImpl: request,
  });
} else if (process.argv.includes("--prompt")) {
  const response = await request("http://127.0.0.1/v1/fleet/lead/prompt");
  if (!response.ok) throw new Error("Remote lead prompt unavailable");
  process.stdout.write(await response.text());
} else {
  let reconnectNeeded = false;
  const connect = () =>
    connectLaneUpstream({
      host: "http://127.0.0.1",
      bearer: token,
      conversationId,
      fetchImpl: request,
      onTransportEvent: ({ event }) => {
        if (event === "upstream_closed" || event === "upstream_error") reconnectNeeded = true;
      },
    });
  let upstream: Awaited<ReturnType<typeof connectLaneUpstream>>;
  for (;;) {
    try {
      upstream = await connect();
      break;
    } catch (error) {
      if (closing.signal.aborted) throw error;
      process.stderr.write("Remote lead bridge reconnecting\n");
      await delay(5000, undefined, { signal: closing.signal });
    }
  }
  const server = createSeatBridge(upstream, "operator");
  server.onclose = () => closing.abort();
  await server.connect(new StdioServerTransport());
  // Idle heads must recover tools too. Catalog reads reconnect the existing
  // upstream generation without replaying any potentially admitted tool call.
  const health = (async () => {
    while (!closing.signal.aborted) {
      try {
        if (reconnectNeeded) {
          await upstream.listTools();
          reconnectNeeded = false;
        }
      } catch {
        if (!closing.signal.aborted) process.stderr.write("Remote lead bridge reconnecting\n");
      }
      await delay(5000, undefined, { signal: closing.signal }).catch(() => undefined);
    }
  })();
  await pumpSeatEvents(server, upstream, closing.signal, {
    onError: () => {
      reconnectNeeded = true;
    },
  });
  closing.abort();
  await health;
  await upstream.close();
  await server.close();
}
