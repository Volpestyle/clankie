/** Real worker HTTP/stdio MCP transports and Mineflayer packets; no shared world or Paper. */
import { once, type EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Server as NetServer } from "node:net";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import type { MinecraftStatus } from "@clankie/protocol";
import { expect, it } from "vitest";
import { BodyLeaseStore } from "../src/body-leases.ts";
import type { BodyConversationIdentity } from "../src/body-lease-router.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { MinecraftMcpPort } from "../src/minecraft-mcp.ts";
import { MinecraftService } from "../src/minecraft.ts";
import { createMinecraftRoutes } from "../src/minecraft-routes.ts";
import { minecraftTools } from "../src/captain/minecraft-tools.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";

const integrationRequire = createRequire(
  new URL("../../../integrations/minecraft-mcp/package.json", import.meta.url),
);
const mineflayerRequire = createRequire(integrationRequire.resolve("mineflayer"));
interface ProtocolClient extends EventEmitter {
  id: number;
  write(name: string, packet: Record<string, unknown>): void;
  end(reason?: string): void;
}
interface ProtocolServer extends EventEmitter {
  socketServer: NetServer;
  clients: Record<string, ProtocolClient>;
  close(): void;
}
const protocol = mineflayerRequire("minecraft-protocol") as {
  createServer(options: Record<string, unknown>): ProtocolServer;
};
const data = integrationRequire("minecraft-data")("1.16.5") as {
  loginPacket: Record<string, unknown>;
};
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function gate() {
  let release!: () => void;
  let reached!: () => void;
  return {
    hold: new Promise<void>((resolve) => {
      release = resolve;
    }),
    reached: new Promise<void>((resolve) => {
      reached = resolve;
    }),
    release: () => release(),
    signal: () => reached(),
  };
}

it("keeps one owned stay through native driver handoff, takeback and dispatch revocation fences", async () => {
  const directory = await mkdtemp(join(tmpdir(), "minecraft-driver-boundary-"));
  const chats: string[] = [];
  let connections = 0;
  const world = protocol.createServer({
    host: "127.0.0.1",
    port: 0,
    version: "1.16.5",
    "online-mode": false,
    keepAlive: false,
  });
  world.on("playerJoin", (client: ProtocolClient) => {
    connections++;
    client.write("login", { ...data.loginPacket, entityId: client.id, hashedSeed: [0, 0], gameMode: 0 });
    client.write("position", { x: 0, y: 64, z: 0, yaw: 0, pitch: 0, flags: 0, teleportId: 1 });
    client.write("update_health", { health: 20, food: 20, foodSaturation: 5 });
    const uuid = "00000000-0000-4000-8000-000000000007";
    client.write("player_info", {
      action: "add_player",
      data: [{ uuid, name: "Friend", properties: [], gamemode: 0, ping: 0, displayName: null }],
    });
    client.write("named_entity_spawn", {
      entityId: 7,
      playerUUID: uuid,
      x: 4,
      y: 64,
      z: 0,
      yaw: 0,
      pitch: 0,
    });
    client.on("chat", ({ message }: { message: string }) => chats.push(message));
  });
  await once(world, "listening");
  const address = world.socketServer.address();
  if (!address || typeof address === "string") throw new Error("Minecraft fixture address unavailable");
  const endpoint = {
    host: "127.0.0.1",
    port: address.port,
    version: "1.16.5",
    username: "DriverBoundary",
    auth: "offline" as const,
  };
  const settings = new SettingsStore(join(directory, "settings.json"));
  await settings.update((value) => ({ ...value, fleet: { ...value.fleet, tools: "connected" } }));
  const credentials = new FileCredentialStore(join(directory, "credentials.json"));
  // The fixture MCP server hosts the production motor with only the optional browser disabled.
  const imports = (specifier: string) =>
    JSON.stringify(pathToFileURL(integrationRequire.resolve(specifier)).href);
  const motorUrl = JSON.stringify(
    new URL("../../../integrations/minecraft-mcp/src/motor.ts", import.meta.url).href,
  );
  const protocolUrl = JSON.stringify(
    new URL("../../../packages/protocol/src/index.ts", import.meta.url).href,
  );
  const motorServer = `
    import { McpServer } from ${imports("@modelcontextprotocol/sdk/server/mcp.js")};
    import { StdioServerTransport } from ${imports("@modelcontextprotocol/sdk/server/stdio.js")};
    import { z } from ${imports("zod")};
    import { MinecraftMotor, EndpointSchema } from ${motorUrl};
    import { MinecraftActionRequestSchema, MinecraftSessionRefSchema } from ${protocolUrl};
    const motor = new MinecraftMotor({viewer:false});
    const server = new McpServer({name:"isolated-real-motor",version:"1"});
    const reply = value => ({content:[{type:"text",text:JSON.stringify(value)}]});
    const session = z.strictObject({session:MinecraftSessionRefSchema});
    const action = z.strictObject({session:MinecraftSessionRefSchema,actionId:z.string().min(1).max(128)});
    server.registerTool("join",{inputSchema:z.strictObject({session:MinecraftSessionRefSchema,profileId:z.string(),endpoint:EndpointSchema})},args=>reply(motor.join(args)));
    server.registerTool("status",{inputSchema:z.strictObject({})},()=>reply(motor.status()));
    server.registerTool("observe",{inputSchema:session},args=>reply(motor.observe(args.session)));
    server.registerTool("act",{inputSchema:MinecraftActionRequestSchema},args=>reply(motor.act(args)));
    server.registerTool("action_status",{inputSchema:action},args=>reply(motor.actionStatus(args.session,args.actionId)));
    server.registerTool("cancel_action",{inputSchema:action},async args=>reply(await motor.cancel(args.session,args.actionId)));
    server.registerTool("leave",{inputSchema:session},args=>reply(motor.leave(args.session)));
    await server.connect(new StdioServerTransport());
    process.on("SIGTERM",async()=>{await motor.close();await server.close();process.exit(0)});
  `;
  const host = createMcpHost({
    settings,
    credentials,
    curated: [],
    logger: { info() {}, warn() {} },
    minecraftMotor: {
      command: process.execPath,
      args: ["--input-type=module", "--eval", motorServer],
      cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    },
  });
  const store = new BodyLeaseStore(join(directory, "leases"));
  const owner: BodyConversationIdentity = {
    conversationId: "driver-owner",
    current: () => true,
    authorize: async () => true,
  };
  const service = new MinecraftService({
    automaticPlay: true,
    store,
    path: join(directory, "session.json"),
    port: new MinecraftMcpPort({
      host,
      profiles: async () => [{ id: "isolated", name: "Isolated packet world" }],
      resolveProfile: async () => endpoint,
    }),
  });
  let validationCalls = 0;
  let blocked: ReturnType<typeof gate> | undefined;
  let finalAdmission: (() => void) | undefined;
  let currentChecks = 0;
  const panes = new Set(["w42:p2", "w42:p3"]);
  const workers = new WorkerMcp({
    directory: join(directory, "worker-grants"),
    credentials,
    host,
    minecraft: service,
    fleetTools: async () => (await settings.load()).fleet.tools,
    fleetToolsSnapshot: async () => {
      const snapshot = await settings.loadFenced();
      return { tools: snapshot.settings.fleet.tools, assertCurrent: snapshot.assertCurrent };
    },
  });
  const routes = createMinecraftRoutes({
    service,
    authorize: async (request) =>
      request.headers.get("authorization") === "Bearer owner"
        ? owner
        : { ...owner, conversationId: "different-owner" },
  });
  const http = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      if (new URL(request.url).pathname !== "/worker") return routes.fetch(request);
      const pane = request.headers.get("x-clankie-pane") ?? "";
      return workers.handleLocalFleet(request, {
        fleet: "default",
        pane,
        current: () => {
          // act crosses initial admission, settlement and adapter dispatch guards,
          // each of which checks the fleet twice. The sixth check follows the
          // final SettingsStore snapshot capture, before MCP's async setup/send.
          if (finalAdmission && ++currentChecks === 6) {
            const change = finalAdmission;
            finalAdmission = undefined;
            change();
          }
          return panes.has(pane);
        },
        validate: async () => {
          if (blocked && ++validationCalls === 4) {
            blocked.signal();
            await blocked.hold;
          }
          return panes.has(pane);
        },
      });
    },
  });
  await once(http, "listening");
  const httpAddress = http.address();
  if (!httpAddress || typeof httpAddress === "string") throw new Error("Worker fixture address unavailable");
  const url = `http://127.0.0.1:${httpAddress.port}`;
  const clients: Client[] = [];
  const connect = async (pane: string) => {
    const client = new Client({ name: "native-driver-boundary", version: "1" });
    clients.push(client);
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url + "/worker"), {
        requestInit: { headers: { "x-clankie-pane": pane } },
      }) as Transport,
    );
    return client;
  };
  const workerCall = async (client: Client, name: string, args: Record<string, unknown> = {}) => {
    const reply = await client.callTool({ name: "clankie_call", arguments: { name, arguments: args } });
    const text =
      (reply.content as { type: string; text?: string }[]).find((entry) => entry.type === "text")?.text ?? "";
    return {
      isError: reply.isError === true,
      text,
      value: reply.isError ? null : (JSON.parse(text) as unknown),
    };
  };
  const command = async (body: unknown, bearer = "owner") =>
    fetch(url + "/v1/minecraft", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });
  const arm = () => {
    validationCalls = 0;
    blocked = gate();
    return blocked;
  };
  try {
    const joinReply = await command({ action: "join", profileId: "isolated" });
    expect(joinReply.status).toBe(200);
    const joined = (await joinReply.json()) as {
      session: { sessionId: string; connectionGeneration: number };
    };
    await expect.poll(async () => (await service.status(owner)).session?.phase).toBe("active");
    const originalLease = store.status("play");
    const oldMind = service.mindContext()!;
    expect(oldMind).toBeDefined();
    const worker = await connect("w42:p2");
    const other = await connect("w42:p3");
    const catalog = await worker.callTool({
      name: "clankie_tools",
      arguments: { names: ["clankie_minecraft_act", "minecraft_act", "minecraft_join"] },
    });
    const catalogText = (catalog.content as { text?: string }[])[0]!.text!;
    expect(JSON.parse(catalogText)).toMatchObject([{ name: "clankie_minecraft_act" }]);
    expect(catalogText).not.toContain('"name":"minecraft_act"');
    expect(
      (
        await workerCall(worker, "clankie_minecraft_act", {
          request: { type: "chat", text: "before-handoff" },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await workerCall(worker, "minecraft_act", {
          session: joined.session,
          actionId: "raw",
          action: { type: "chat", text: "raw" },
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await command(
          { action: "driver", driver: { kind: "worker", principalId: "fleet:default:pane:w42:p2" } },
          "other",
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await command({
          action: "driver",
          driver: { kind: "worker", principalId: "fleet:default:pane:w42:p2", session: joined.session },
        })
      ).status,
    ).toBe(400);
    const handoff = await command({
      action: "driver",
      driver: { kind: "worker", principalId: "fleet:default:pane:w42:p2" },
    });
    expect(handoff.status).toBe(200);
    await expect(
      oldMind.act({
        session: joined.session,
        actionId: "stale-mind",
        action: { type: "chat", text: "stale-mind" },
      }),
    ).rejects.toThrow();
    expect((await workerCall(other, "clankie_minecraft_observe")).isError).toBe(true);
    expect(
      (
        await workerCall(worker, "clankie_minecraft_act", {
          actionId: "worker-chat",
          request: { type: "chat", text: "selected-worker" },
        })
      ).isError,
    ).toBe(false);
    await expect.poll(() => chats).toContain("selected-worker");
    const following = await workerCall(worker, "clankie_minecraft_act", {
      actionId: "worker-follow",
      request: { type: "follow", player: "Friend", distance: 2 },
    });
    expect(following.value).toMatchObject({ state: "running" });
    const captain = minecraftTools(service, { bodyIdentity: owner } as never).find(
      (tool) => tool.name === "minecraft_driver",
    )!;
    expect(
      await captain.execute("takeback", { kind: "owner" }, undefined, undefined, {} as never),
    ).toMatchObject({ details: { driver: { kind: "owner" } } });
    expect((await service.actionStatus("worker-follow", owner))?.state).toBe("cancelled");
    expect(
      (
        await workerCall(worker, "clankie_minecraft_act", {
          request: { type: "chat", text: "after-takeback" },
        })
      ).isError,
    ).toBe(true);
    await command({ action: "driver", driver: { kind: "worker", principalId: "fleet:default:pane:w42:p2" } });
    const pendingGeneration = arm();
    const stale = workerCall(worker, "clankie_minecraft_act", {
      actionId: "stale-worker",
      request: { type: "chat", text: "stale-worker" },
    });
    await pendingGeneration.reached;
    expect((await command({ action: "driver", driver: { kind: "owner" } })).status).toBe(200);
    pendingGeneration.release();
    expect((await stale).isError).toBe(true);
    blocked = undefined;
    await command({ action: "driver", driver: { kind: "worker", principalId: "fleet:default:pane:w42:p2" } });
    currentChecks = 0;
    let finalSettingsChange = false;
    finalAdmission = () => {
      // Atomically replace the actual isolated settings file, as another
      // settings writer can, after admission has read its original inode.
      const changed = JSON.parse(readFileSync(settings.path, "utf8"));
      changed.fleet.tools = "off";
      const nextPath = join(directory, "late-fleet-settings.json");
      writeFileSync(nextPath, JSON.stringify(changed), { mode: 0o600 });
      renameSync(nextPath, settings.path);
      finalSettingsChange = true;
    };
    const lateOff = await workerCall(worker, "clankie_minecraft_act", {
      actionId: "final-send-fleet-off",
      request: { type: "chat", text: "final-send-fleet-off" },
    });
    expect(finalSettingsChange).toBe(true);
    expect(currentChecks).toBe(6);
    expect((await new SettingsStore(settings.path).load()).fleet.tools).toBe("off");
    expect(lateOff.isError).toBe(true);
    expect(await service.actionStatus("final-send-fleet-off", owner)).toBeNull();
    await settings.update((value) => ({ ...value, fleet: { ...value.fleet, tools: "connected" } }));
    currentChecks = 0;
    let lateHandoff: Promise<unknown> | undefined;
    finalAdmission = () => {
      // The handoff changes generation before waiting on the real motor;
      // the already-admitted worker call is still awaiting MCP setup.
      lateHandoff = service.setDriver({ kind: "owner" }, owner);
    };
    const lateDriver = await workerCall(worker, "clankie_minecraft_act", {
      actionId: "final-send-driver-changed",
      request: { type: "chat", text: "final-send-driver-changed" },
    });
    expect(lateHandoff).toBeDefined();
    expect(currentChecks).toBe(6);
    expect(await lateHandoff).toMatchObject({ driver: { kind: "owner" } });
    expect(lateDriver.isError).toBe(true);
    expect(await service.actionStatus("final-send-driver-changed", owner)).toBeNull();
    await command({ action: "driver", driver: { kind: "worker", principalId: "fleet:default:pane:w42:p2" } });
    const pendingFleet = arm();
    const revoked = workerCall(worker, "clankie_minecraft_act", {
      actionId: "fleet-off",
      request: { type: "chat", text: "fleet-off" },
    });
    await pendingFleet.reached;
    await settings.update((value) => ({ ...value, fleet: { ...value.fleet, tools: "off" } }));
    pendingFleet.release();
    expect((await revoked).isError).toBe(true);
    blocked = undefined;
    expect((await worker.listTools()).tools).toEqual([]);
    expect((await command({ action: "driver", driver: { kind: "mind" } })).status).toBe(200);
    expect(service.mindContext()?.session).toEqual(joined.session);
    expect((await service.status(owner)).session?.session).toEqual(joined.session);
    expect(store.status("play")).toMatchObject({
      conversationId: originalLease!.conversationId,
      state: originalLease!.state,
    });
    expect(connections).toBe(1);
    expect(chats).toEqual(["selected-worker"]);
    expect((await host.catalog("operator")).some((tool) => tool.server === "minecraft")).toBe(false);
    const publicStatus = await fetch(url + "/v1/minecraft", { headers: { authorization: "Bearer owner" } });
    expect(((await publicStatus.json()) as MinecraftStatus).session?.session).toEqual(joined.session);
    await command({ action: "leave" });
    await expect.poll(async () => (await service.status(owner)).session?.phase).toBe("disconnected");
    expect(store.status("play")).toBeUndefined();
  } finally {
    blocked?.release();
    await Promise.allSettled(clients.map((client) => client.close()));
    await workers.close();
    await service.leave(owner).catch(() => undefined);
    for (let attempt = 0; attempt < 20 && store.status("play"); attempt++) {
      await service.status(owner).catch(() => undefined);
      await sleep(25);
    }
    await host.close();
    store.close();
    for (const client of Object.values(world.clients)) client.end();
    world.close();
    (http as HttpServer).closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
    await rm(directory, { recursive: true, force: true });
  }
});
