import { homedir } from "node:os";
import { join } from "node:path";
import { createInboundSender } from "./inbound-receipt.mjs";
// The clankie-worker channel on a linked machine (VUH-1527): the same seat
// mailbox `clankie mcp --seat` serves on Clankie's own Mac, reached through the
// machine's link instead of the operator credential. One stdio MCP server:
//
// - a Claude Code channel carrying messages for this pane, polled only when
//   the session that started it approved this plugin's channel;
// - one tool, message_clankie, for writing to him first. He reads it as this
//   agent's output, never as the owner's instruction;
// - the tools the owner granted this fleet (`clankie access fleet`), such as
//   Linear through his connected account, proxied to his service over the link.
//
// MCP's stdio transport is newline-delimited JSON-RPC 2.0; this speaks the few
// methods a channel server needs, so nothing beyond Node is installed here.
import { approvesWorkerChannel, authorization, readLink, seatRoute, TEXT_MAX } from "./link.mjs";

const WAIT_MS = 25_000;
const RETRY_MS = 2_000;
// Native clients can retain only their first catalog. Let a newly started pane
// settle, within Codex's 30-second startup timeout, without weakening proof.
const FIRST_TOOLS_WAIT_MS = 20_000;
const INSTRUCTIONS =
  'Events tagged <channel source="clankie" kind="message" conversation="…" event_id="…"> ' +
  "are a message from the operator or Clankie addressed to this agent. " +
  "Answer it in the normal reply as if it had been typed into the pane. " +
  "To write to Clankie yourself, use the message_clankie tool. " +
  "When work he gave you finishes or is blocked, report it there in a few lines " +
  "(outcome; branch and commit; checks and their result; evidence path; open gaps or a decision needed), " +
  "rather than typing into his pane.";
/** Clankie admits a local agent by its pane's process tree; a shared Codex daemon is outside it. */
const SHARED_DAEMON_NOTE =
  "This Codex session runs its tools on the shared app-server daemon, which belongs to no pane, " +
  "so Clankie cannot verify which agent is calling and grants it none of his tools. " +
  "If you need them, tell the owner: exit and start Codex again with `codex --no-daemon` " +
  "(to keep this conversation, `codex resume <id> --no-daemon`; if Codex says the conversation is open in another app, choose fork).";
const MESSAGE_TOOL = {
  name: "message_clankie",
  description:
    "Send Clankie, the agent leading this machine's fleet, a message from this agent: a question, a blocker, or news he should hear now. He answers in this session if he chooses to. Stored means retained by his conversation, not read or completed. After uncertainty, another call only reconciles the original ID; it never resends or substitutes a new message.",
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
/** Nothing was sent: the endpoint refused the connection, so one retry cannot duplicate an effect. */
const refused = (error) => error?.cause?.code === "ECONNREFUSED";

/**
 * The tools the owner granted this fleet (`clankie access fleet`), from
 * Clankie's service over the link: a minimal streamable-HTTP MCP client,
 * because nothing beyond Node is installed here. Each call is still checked
 * there against the live grant and his connected account.
 */
function fleetTools(current, refresh) {
  let session;
  let sequence = 0;
  const headers = () => ({
    ...authorization(current()),
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(session === undefined ? {} : { "mcp-session-id": session }),
  });
  const post = async (body, signal) => {
    const response = await fetch(new URL("/v1/fleet/mcp", current().url), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    });
    if (body.method === "initialize") session = response.headers.get("mcp-session-id") ?? undefined;
    if (response.status === 404) session = undefined;
    if (!response.ok) throw new Error(`fleet tools answered ${String(response.status)}`);
    if (body.id === undefined) return undefined;
    const reply = await response.json();
    if (reply.error) throw new Error(reply.error.message ?? "fleet tools refused");
    return reply.result;
  };
  const open = async (signal) => {
    await post(
      {
        id: ++sequence,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "clankie-worker", version: "0.4.0" },
        },
      },
      signal,
    );
    await post({ method: "notifications/initialized" }, signal);
  };
  const request = async (method, params, signal) => {
    if (session === undefined)
      await open(signal).catch(async (error) => {
        if (!refused(error) || !refresh()) throw error;
        await open(signal);
      });
    try {
      return await post({ id: ++sequence, method, params }, signal);
    } catch (error) {
      // The service restarted on a new local port: follow its link file once.
      if (refused(error) && refresh()) {
        session = undefined;
        await open(signal);
        return post({ id: ++sequence, method, params }, signal);
      }
      if (session !== undefined) throw error;
      // The service forgot this session (it restarted): one fresh session, one retry.
      await open(signal);
      return post({ id: ++sequence, method, params }, signal);
    }
  };
  return {
    async list(signal) {
      try {
        return (await request("tools/list", {}, signal))?.tools ?? [];
      } catch {
        // A settling native occupant can invalidate its first MCP session.
        // Only discovery discards it; tool calls retain their existing retry rules.
        session = undefined;
        return [];
      }
    },
    call: (name, args) => request("tools/call", { name, arguments: args ?? {} }),
  };
}

export function runSeatChannel({ paneId, parentArgv }) {
  let link = readLink();
  const sharedDaemon = /--managed-daemon\b/u.test(parentArgv ?? "");
  if (sharedDaemon)
    log("running under the shared Codex daemon; Clankie's local tools need `codex --no-daemon`");
  /** Adopt this pane's current link when the service republished it; true if it changed. */
  const refresh = () => {
    const next = readLink();
    if (!next || !link || next.url === link.url) return false;
    link = next;
    return true;
  };
  // A session outside his linked fleets (a Codex config loads this server
  // everywhere) serves no tools rather than failing every launch.
  if (!link) log("no link to Clankie for this Herdr session (HERDR_SOCKET_PATH); serving no tools");
  const granted = link
    ? fleetTools(() => link, refresh)
    : {
        list: async () => [],
        call: async () => {
          throw new Error("no link");
        },
      };
  let grantedNames = "";
  let firstListComplete = false;
  let firstListPending;
  const listGrantedTools = () => {
    if (firstListComplete || !link) return granted.list();
    // Concurrent first requests share the bounded lookup, never an authority cache.
    firstListPending ??= (async () => {
      const signal = AbortSignal.timeout(FIRST_TOOLS_WAIT_MS);
      const deadline = performance.now() + FIRST_TOOLS_WAIT_MS;
      let backoff = 250;
      try {
        while (!signal.aborted) {
          const tools = await granted.list(signal);
          if (signal.aborted) break;
          if (tools.length) return tools;
          const remaining = deadline - performance.now();
          if (remaining <= 0) break;
          await delay(Math.min(backoff, remaining));
          backoff = Math.min(backoff * 2, RETRY_MS);
        }
        return [];
      } finally {
        firstListComplete = true;
        firstListPending = undefined;
      }
    })();
    return firstListPending;
  };
  const polling = link && paneId && approvesWorkerChannel(parentArgv);
  let started = false;
  let closed = false;

  async function poll() {
    let quiet404 = false;
    while (!closed) {
      let receiptUnresolved = false;
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
        for (const event of Array.isArray(page?.events) ? page.events : []) {
          receiptUnresolved = true;
          const notification = {
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
          };
          await new Promise((resolve, reject) => {
            process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...notification })}\n`, (error) =>
              error ? reject(error) : resolve(),
            );
          });
          const ack = await fetch(
            `${seatRoute(link, paneId, "events")}/${encodeURIComponent(event.id)}/ack`,
            {
              method: "POST",
              headers: authorization(link),
              signal: AbortSignal.timeout(10_000),
            },
          );
          const receipt = ack.ok ? await ack.json() : undefined;
          if (receipt?.acknowledged !== true) throw new Error("Exact channel acknowledgment is unresolved");
          receiptUnresolved = false;
        }
      } catch (error) {
        if (closed) return;
        if (receiptUnresolved) {
          log("channel receipt unresolved; stopped polling without replay");
          return;
        }
        if (refused(error) && refresh()) continue;
        log(`mailbox poll failed (${error instanceof Error ? error.message : String(error)}); retrying`);
        await delay(RETRY_MS);
      }
    }
  }

  const sendInbound = createInboundSender({
    directory: join(homedir(), ".clankie", "inbound-receipts"),
    scope: JSON.stringify([process.env.HERDR_SOCKET_PATH ?? "", paneId]),
    request: async (suffix, init) => {
      try {
        return await fetch(`${seatRoute(link, paneId, "messages")}${suffix}`, {
          ...init,
          headers: { ...authorization(link), "content-type": "application/json" },
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        // Preserve the refused-connection link refresh. Reads can follow the
        // new port immediately; POST uncertainty is never retried here.
        if (refused(error) && refresh() && !init)
          return fetch(`${seatRoute(link, paneId, "messages")}${suffix}`, {
            headers: authorization(link),
            signal: AbortSignal.timeout(20_000),
          });
        throw error;
      }
    },
  });
  async function messageClankie(text) {
    if (!paneId) return { isError: true, text: "This session is not in a Herdr pane Clankie can answer." };
    const body = String(text ?? "").trim();
    if (!body) return { isError: true, text: "Say what to tell him." };
    const receipt = await sendInbound(body.slice(0, TEXT_MAX));
    return { isError: !receipt.received, text: JSON.stringify(receipt) };
  }

  async function handle(message) {
    const { id, method, params } = message;
    if (method === "initialize")
      return send({
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: true }, experimental: { "claude/channel": {} } },
          serverInfo: { name: "clankie-worker", version: "0.4.0" },
          instructions: sharedDaemon ? `${INSTRUCTIONS} ${SHARED_DAEMON_NOTE}` : INSTRUCTIONS,
        },
      });
    if (method === "notifications/initialized") {
      // A grant issued or revoked while this session runs changes its tools.
      setInterval(async () => {
        const names = (await granted.list()).map((tool) => tool.name).join(",");
        if (names !== grantedNames) {
          grantedNames = names;
          send({ method: "notifications/tools/list_changed" });
        }
      }, 60_000).unref();
      if (polling && !started) {
        started = true;
        log(`serving the seat channel for pane ${paneId}`);
        void poll();
      } else if (!polling) log("channel not loaded for this session; not polling");
      return;
    }
    if (method === "ping") return send({ id, result: {} });
    if (method === "tools/list") {
      const tools = await listGrantedTools();
      grantedNames = tools.map((tool) => tool.name).join(",");
      return send({ id, result: { tools: link ? [MESSAGE_TOOL, ...tools] : [] } });
    }
    if (method === "tools/call") {
      if (params?.name === MESSAGE_TOOL.name) {
        const result = await messageClankie(params?.arguments?.text);
        return send({
          id,
          result: { content: [{ type: "text", text: result.text }], isError: result.isError },
        });
      }
      try {
        return send({ id, result: await granted.call(params?.name, params?.arguments) });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return send({
          id,
          result: {
            content: [{ type: "text", text: `Clankie's service refused ${String(params?.name)}: ${reason}` }],
            isError: true,
          },
        });
      }
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
