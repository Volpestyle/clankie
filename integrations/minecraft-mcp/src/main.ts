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
import { createDefaultCredentialStore } from "@clankie/credential-broker";
import {
  MinecraftHost,
  HostAdminSchema,
  HostConfigurationPatchSchema,
  type MinecraftHostingPort,
} from "./hosting.ts";
import { MinecraftTunnel } from "./tunnel.ts";

const flag = (name: string) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const credentials = createDefaultCredentialStore();
let tunnel: MinecraftTunnel;
const host: MinecraftHostingPort = new MinecraftHost({
  ...(flag("--data-dir") ? { dataDir: flag("--data-dir")! } : {}),
  ...(flag("--game-port") ? { gamePort: Number(flag("--game-port")) } : {}),
  ...(flag("--rcon-port") ? { rconPort: Number(flag("--rcon-port")) } : {}),
  ...(flag("--java") ? { java: flag("--java")! } : {}),
  ...(flag("--idle-timeout-ms") ? { idleTimeoutMs: Number(flag("--idle-timeout-ms")) } : {}),
  ...(flag("--max-uptime-ms") ? { maxUptimeMs: Number(flag("--max-uptime-ms")) } : {}),
  credentials,
  onUnavailable: async () => {
    if (tunnel) await tunnel.stop();
  },
});
const createTunnel = () =>
  new MinecraftTunnel({
    dataDir: host.dataDir,
    originPort: host.status().gamePort,
    authReady: () => host.status().authReady,
    credentials: {
      get: async () => {
        const credential = await credentials.get("clankie_minecraft_playit");
        return credential?.type === "api" ? credential.key : null;
      },
      set: async (secret: string) =>
        credentials.set("clankie_minecraft_playit", { type: "api", key: secret }),
    },
  });
tunnel = createTunnel();
let tunnelPort = host.status().gamePort;
const currentTunnel = async () => {
  await host.configuration();
  if (tunnelPort !== host.status().gamePort) {
    await tunnel.stop();
    tunnel = createTunnel();
    tunnelPort = host.status().gamePort;
  }
  return tunnel;
};
const motor = new MinecraftMotor({
  isHosted: (endpoint) =>
    endpoint.host === "127.0.0.1" &&
    endpoint.port === host.status().gamePort &&
    endpoint.username === host.status().botUsername,
  hostedLogin: (endpoint) => host.botLogin(endpoint),
});
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

server.registerTool(
  "host_configuration",
  { description: "Operator hosted server resource/lifecycle settings.", inputSchema: z.strictObject({}) },
  async () => result(await host.configuration()),
);
server.registerTool(
  "host_configure",
  {
    description: "Update integration-owned settings while stopped.",
    inputSchema: z.strictObject({ settings: HostConfigurationPatchSchema }),
  },
  async ({ settings }) => {
    const configuration = await host.configure(settings);
    await currentTunnel();
    return result(configuration);
  },
);
server.registerTool(
  "host_status",
  {
    description: "Private hosted server and tunnel status; never credentials.",
    inputSchema: z.strictObject({}),
  },
  async () => {
    await currentTunnel();
    return result({ ...host.status(), tunnel: tunnel.status() });
  },
);
server.registerTool(
  "host_lifecycle",
  {
    description: "Operator-owned hosted server lifecycle.",
    inputSchema: z.strictObject({ operation: z.enum(["start", "stop", "restart"]) }),
  },
  async ({ operation }) => {
    if (operation === "stop" || operation === "restart") {
      try {
        await motor.close();
      } catch {
        await host.stop();
        throw new Error("Minecraft bot shutdown unconfirmed; hosted server stopped");
      }
    }
    const status = await host[operation]();
    if (operation !== "stop") await (await currentTunnel()).start();
    return result({ ...status, tunnel: tunnel.status() });
  },
);
server.registerTool(
  "host_backup",
  {
    description: "Flush and archive hosted worlds, retaining seven backups.",
    inputSchema: z.strictObject({}),
  },
  async () => result(await host.backup()),
);
server.registerTool(
  "host_admin",
  {
    description: "Strict hosted-world command; no op, selectors, raw console or credentials.",
    inputSchema: z.strictObject({ command: HostAdminSchema }),
  },
  async ({ command }) => result(await host.admin(command)),
);
server.registerTool(
  "host_enroll",
  {
    description:
      "Private core-only enrollment provisioning; caller binds Discord identity before whitelist admission.",
    inputSchema: z.strictObject({ username: z.string().regex(/^[A-Za-z0-9_]{3,16}$/u) }),
  },
  async ({ username }) => result(await host.enroll(username)),
);
server.registerTool(
  "host_revoke_code",
  {
    description: "Revoke a pending private login code.",
    inputSchema: z.strictObject({ username: z.string().regex(/^[A-Za-z0-9_]{3,16}$/u) }),
  },
  async ({ username }) => result(await host.revokeCode(username)),
);
server.registerTool(
  "host_claim",
  { description: "Prepare one owner playit account claim.", inputSchema: z.strictObject({}) },
  async () => result(await (await currentTunnel()).prepareClaim()),
);
server.registerTool(
  "host_claim_complete",
  { description: "Complete an approved playit claim into broker storage.", inputSchema: z.strictObject({}) },
  async () => result(await (await currentTunnel()).completeClaim()),
);
await server.connect(new StdioServerTransport());
let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  void (async () => {
    try {
      await motor.close();
    } finally {
      try {
        await tunnel.stop();
      } finally {
        await host.stop();
      }
    }
  })()
    .catch(() => {
      process.exitCode = 1;
    })
    .finally(() => server.close());
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.stdin.on("end", shutdown);
