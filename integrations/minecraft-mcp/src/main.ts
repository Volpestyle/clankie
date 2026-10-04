#!/usr/bin/env node
/** Modified from yuniko Minecraft MCP 240c8cec: lazy owned bot and action-handle MCP surface. */
import {
  MinecraftActionRequestSchema,
  MinecraftSessionRefSchema,
  MinecraftServerProfileIdSchema,
} from "@clankie/protocol";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { EndpointSchema, MinecraftMotor } from "./motor.ts";

const motor = new MinecraftMotor();
const server = new McpServer({ name: "clankie-minecraft", version: "0.1.0" });
const session = { session: MinecraftSessionRefSchema };
const action = { ...session, actionId: z.string().min(1).max(128) };
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
  ...(value && typeof value === "object" ? { structuredContent: value as Record<string, unknown> } : {}),
});

server.registerTool(
  "join",
  {
    description:
      "Operator-only approved, resolved endpoint. Lazily join an exact host session; no automatic reconnect.",
    inputSchema: z.strictObject({
      ...session,
      profileId: MinecraftServerProfileIdSchema,
      endpoint: EndpointSchema,
    }),
  },
  async (args) => result(motor.join(args)),
);
server.registerTool(
  "status",
  { description: "Current exact connection and bounded action history.", inputSchema: z.strictObject({}) },
  async () => result(motor.status()),
);
server.registerTool(
  "observe",
  {
    description: "Bounded current bot observations; provenance is explicit.",
    inputSchema: z.strictObject(session),
  },
  async ({ session }) => result(motor.observe(session)),
);
server.registerTool(
  "act",
  {
    description: "Start one action and promptly return its handle. Completed does not imply verified effect.",
    inputSchema: MinecraftActionRequestSchema,
  },
  async (args, extra) => {
    const handle = motor.act(args);
    // Transport abort requests the same real motor stop; status survives the dropped RPC response.
    extra.signal.addEventListener(
      "abort",
      () => {
        try {
          motor.cancel(args.session, args.actionId);
        } catch {}
      },
      { once: true },
    );
    return result(handle);
  },
);
server.registerTool(
  "action_status",
  { description: "Read a retained action handle.", inputSchema: z.strictObject(action) },
  async ({ session, actionId }) => result(motor.actionStatus(session, actionId)),
);
server.registerTool(
  "cancel_action",
  {
    description: "Immediately clear navigation, controls and digging; fence all later action steps.",
    inputSchema: z.strictObject(action),
  },
  async ({ session, actionId }) => result(motor.cancel(session, actionId)),
);
server.registerTool(
  "pause",
  {
    description: "Stop the motor while retaining the exact bot connection.",
    inputSchema: z.strictObject(session),
  },
  async ({ session }) => result(motor.pause(session)),
);
server.registerTool(
  "resume",
  {
    description: "Permit fresh actions after pause; old actions are never resumed.",
    inputSchema: z.strictObject(session),
  },
  async ({ session }) => result(motor.resume(session)),
);
server.registerTool(
  "leave",
  {
    description: "Request departure. Only an exact end event changes termination to confirmed.",
    inputSchema: z.strictObject(session),
  },
  async ({ session }) => result(motor.leave(session)),
);
server.registerTool(
  "chat",
  {
    description: "Send bounded game chat through an action handle.",
    inputSchema: z.strictObject({ ...action, text: z.string().min(1).max(256) }),
  },
  async ({ session, actionId, text }) =>
    result(motor.act({ session, actionId, action: { type: "chat", text } })),
);
server.registerTool(
  "follow_player",
  {
    description: "Continuously follow a visible player until cancelled.",
    inputSchema: z.strictObject({
      ...action,
      player: z.string().min(1).max(64),
      distance: z.number().positive().max(64),
    }),
  },
  async ({ session, actionId, player, distance }) =>
    result(motor.act({ session, actionId, action: { type: "follow", player, distance } })),
);
server.registerTool(
  "poll_events",
  {
    description: "Read bounded untrusted game events after a cursor; detect dropped history.",
    inputSchema: z.strictObject({
      ...session,
      afterSequence: z.number().int().nonnegative().optional(),
      limit: z.number().int().min(1).max(64).optional(),
    }),
  },
  async ({ session, afterSequence, limit }) => result(motor.pollEvents(session, afterSequence, limit)),
);
server.registerTool(
  "viewer_status",
  {
    description: "Read same-bot loopback PNG frame endpoint, capped at 256 KiB.",
    inputSchema: z.strictObject(session),
  },
  async ({ session }) => result(motor.viewerStatus(session)),
);

await server.connect(new StdioServerTransport());
let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  void motor.close().finally(() => server.close());
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.on("end", shutdown);
