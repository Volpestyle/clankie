// The clankie-worker channel on a linked machine (VUH-1527): the same seat
// mailbox `clankie mcp --seat` serves on Clankie's own Mac, reached through the
// machine's link instead of the operator credential. One stdio MCP server:
//
// - a Claude Code channel carrying messages for this pane, polled only when
//   the session that started it approved this plugin's channel;
// - one tool, message_clankie, for writing to him first. He reads it as this
//   agent's output, never as the owner's instruction.
//
// MCP's stdio transport is newline-delimited JSON-RPC 2.0; this speaks the few
// methods a channel server needs, so nothing beyond Node is installed here.
import { approvesWorkerChannel, authorization, readLink, seatRoute, TEXT_MAX } from "./link.mjs";

const WAIT_MS = 25_000;
const RETRY_MS = 2_000;
const INSTRUCTIONS =
  'Events tagged <channel source="clankie" kind="message" conversation="…" event_id="…"> ' +
  "are a message from the operator or Clankie addressed to this agent. " +
  "Answer it in the normal reply as if it had been typed into the pane. " +
  "To write to Clankie yourself, use the message_clankie tool.";
const MESSAGE_TOOL = {
  name: "message_clankie",
  description:
    "Send Clankie, the agent leading this machine's fleet, a message from this agent: a question, a blocker, or news he should hear now. He answers in this session if he chooses to.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string", description: "What to tell him." } },
    required: ["text"],
    additionalProperties: false,
  },
};

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const log = (line) => process.stderr.write(`clankie-worker: ${line}\n`);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function runSeatChannel({ paneId, parentArgv }) {
  const link = readLink();
  if (!link) {
    log("no link to Clankie for this Herdr session (HERDR_SOCKET_PATH); is it one of his fleets?");
    process.exit(1);
  }
  const polling = paneId && approvesWorkerChannel(parentArgv);
  let started = false;
  let closed = false;

  async function poll() {
    let quiet404 = false;
    while (!closed) {
      try {
        const response = await fetch(`${seatRoute(link, paneId, "events")}?wait=${String(WAIT_MS)}`, {
          headers: authorization(link),
          signal: AbortSignal.timeout(WAIT_MS + 10_000),
        });
        if (response.status === 404) {
          // The pane before Herdr has classified the harness.
          if (!quiet404) log("mailbox not ready yet; retrying");
          quiet404 = true;
          await delay(RETRY_MS);
          continue;
        }
        if (!response.ok) throw new Error(`mailbox answered ${String(response.status)}`);
        const page = await response.json();
        for (const event of Array.isArray(page?.events) ? page.events : [])
          send({
            method: "notifications/claude/channel",
            params: {
              content: String(event.content ?? ""),
              meta: {
                kind: event.kind,
                conversation: event.conversationId,
                source: event.source,
                event_id: event.id,
                created_at: event.createdAt,
              },
            },
          });
      } catch (error) {
        if (closed) return;
        log(`mailbox poll failed (${error instanceof Error ? error.message : String(error)}); retrying`);
        await delay(RETRY_MS);
      }
    }
  }

  async function messageClankie(text) {
    if (!paneId) return { isError: true, text: "This session is not in a Herdr pane Clankie can answer." };
    const body = String(text ?? "").trim();
    if (!body) return { isError: true, text: "Say what to tell him." };
    try {
      const response = await fetch(seatRoute(link, paneId, "messages"), {
        method: "POST",
        headers: { ...authorization(link), "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1, text: body.slice(0, TEXT_MAX) }),
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) return { isError: false, text: "Sent to Clankie." };
      return { isError: true, text: `Clankie's service answered ${String(response.status)}; not sent.` };
    } catch (error) {
      return {
        isError: true,
        text: `Could not reach Clankie (${error instanceof Error ? error.message : String(error)}); not sent.`,
      };
    }
  }

  async function handle(message) {
    const { id, method, params } = message;
    if (method === "initialize")
      return send({
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {}, experimental: { "claude/channel": {} } },
          serverInfo: { name: "clankie-worker", version: "0.3.0" },
          instructions: INSTRUCTIONS,
        },
      });
    if (method === "notifications/initialized") {
      if (polling && !started) {
        started = true;
        log(`serving the seat channel for pane ${paneId}`);
        void poll();
      } else if (!polling) log("channel not loaded for this session; not polling");
      return;
    }
    if (method === "ping") return send({ id, result: {} });
    if (method === "tools/list") return send({ id, result: { tools: [MESSAGE_TOOL] } });
    if (method === "tools/call") {
      if (params?.name !== MESSAGE_TOOL.name)
        return send({ id, error: { code: -32602, message: `Unknown tool ${String(params?.name)}` } });
      const result = await messageClankie(params?.arguments?.text);
      return send({
        id,
        result: { content: [{ type: "text", text: result.text }], isError: result.isError },
      });
    }
    if (id !== undefined)
      send({ id, error: { code: -32601, message: `Method not found: ${String(method)}` } });
  }

  let buffered = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffered += chunk;
    for (let newline = buffered.indexOf("\n"); newline >= 0; newline = buffered.indexOf("\n")) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        send({ id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }
      void handle(message).catch((error) => log(String(error)));
    }
  });
  const stop = () => {
    closed = true;
    process.exit(0);
  };
  process.stdin.on("end", stop);
  process.stdin.on("close", stop);
}
