/** Manual only: requires the disposable spike Paper server, no live Clankie restart. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import type { MinecraftActionStatus, MinecraftStatus } from "@clankie/protocol";
import mineflayer from "mineflayer";
import { runMinecraftCommand } from "../../tui/src/command/minecraft.ts";
import { BodyLeaseStore } from "../src/body-leases.ts";
import { createMinecraftRoutes } from "../src/minecraft-routes.ts";
import { MinecraftCapture } from "../src/minecraft-capture.ts";
import { minecraftProfiles, resolveMinecraftProfile } from "../src/minecraft-destination.ts";
import { MinecraftMcpPort } from "../src/minecraft-mcp.ts";
import { MinecraftService } from "../src/minecraft.ts";
import { createMcpHost } from "../src/mcp-host.ts";

const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
if (outputIndex < 0 || args[outputIndex + 1] === undefined)
  throw new Error(
    "Usage: pnpm --filter @clankie/clankie minecraft:smoke --output PRIVATE_DIRECTORY [--spike DIRECTORY] [--routes-only]",
  );
const output = resolve(args[outputIndex + 1]!);
const spikeIndex = args.indexOf("--spike");
const spike = resolve(spikeIndex < 0 ? join(homedir(), "dev/minecraft-spike") : args[spikeIndex + 1]!);
const repoRoot = resolve(import.meta.dirname, "../../..");
const { rcon } = (await import(pathToFileURL(join(spike, "rcon.mjs")).href)) as {
  rcon(command: string): Promise<string>;
};
assert.match(await rcon("list"), /There are 0 of/u, "Do not modify a world occupied by others");
await mkdir(join(output, "frames"), { recursive: true });
const runId = randomUUID();
const settings = new SettingsStore(join(output, `smoke-settings-${runId}.json`));
const env = { ...process.env, CLANKIE_SETTINGS_FILE: settings.path, CLANKIE_OPERATOR_TOKEN: randomUUID() };
const leases = new BodyLeaseStore(join(output, `smoke-body-${runId}`));
const host = createMcpHost({
  minecraftMotor: {
    command: process.execPath,
    args: [join(repoRoot, "integrations/minecraft-mcp/src/main.ts")],
    cwd: repoRoot,
  },
  credentials: new FileCredentialStore(join(output, `smoke-credentials-${runId}.json`)),
  settings,
  curated: [],
  logger: { info: () => {}, warn: () => {} },
});
const minecraft = new MinecraftService({
  port: new MinecraftMcpPort({
    host,
    profiles: async () => minecraftProfiles((await settings.load()).minecraft),
    resolveProfile: async (id) => resolveMinecraftProfile((await settings.load()).minecraft, id),
  }),
  store: leases,
  path: join(output, `smoke-session-${runId}.json`),
});
const routesOnly = args.includes("--routes-only");
const authenticated = (request: Request) =>
  request.headers.get("authorization") === `Bearer ${env.CLANKIE_OPERATOR_TOKEN}`;
const app = routesOnly
  ? {
      app: createMinecraftRoutes({
        service: minecraft,
        settings,
        authorize: async (request) =>
          authenticated(request)
            ? {
                conversationId: "global-default",
                current: () => !request.signal.aborted,
                authorize: async () => authenticated(request),
              }
            : undefined,
      }),
      close: () => {},
    }
  : await (async () => {
      const { createClankieApp } = await import("../src/app.ts");
      const { createStubCaptain } = await import("../src/captain/port.ts");
      return createClankieApp({
        captain: createStubCaptain(),
        settings,
        minecraft,
        authenticateOperator: async (request) =>
          authenticated(request) ? { operatorId: "local-smoke" } : undefined,
      });
    })();
const server = serve({ fetch: app.app.fetch, port: 0, hostname: "127.0.0.1" });
await new Promise<void>((done) => server.once("listening", done));
const address = server.address();
assert.ok(address !== null && typeof address !== "string");
const serviceUrl = `http://127.0.0.1:${address.port}`;
const evidence: unknown[] = [];
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const command = async (...words: string[]) => {
  const result = await runMinecraftCommand(words, { env, host: serviceUrl });
  evidence.push({ at: Date.now(), command: ["clankie", "minecraft", ...words], result });
  return result;
};
const independent = async (value: string) => {
  const result = await rcon(value);
  evidence.push({ at: Date.now(), rcon: value, result });
  return result;
};
const waitFor = async <T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> => {
  for (let count = 0; count < 200; count++) {
    const value = await read();
    if (ready(value)) return value;
    await sleep(100);
  }
  throw new Error("Smoke condition did not settle");
};
const terminal = async (handle: Record<string, unknown>) => {
  const id = String(handle.actionId);
  const result = await waitFor(
    async () => {
      const value = await command("action-status", id);
      return value.action as MinecraftActionStatus;
    },
    (value) => !["running", "cancel_requested"].includes(value.state),
  );
  assert.equal(result.state, "completed");
  return result;
};
let friend: ReturnType<typeof mineflayer.createBot> | undefined;
let capture: MinecraftCapture | undefined;
let frames = 0;
let failure: unknown;
try {
  await command(
    "configure",
    "paper",
    "127.0.0.1",
    "--port",
    "25684",
    "--version",
    "1.21.4",
    "--username",
    "Clankie",
  );
  await host.warm();
  assert.match(await independent("list"), /There are 0 of/u, "Warming cannot join");
  await command("join", "paper");
  await waitFor(
    async () => (await command("status")) as MinecraftStatus,
    (value) => value.session?.phase === "active",
  );
  assert.match(await independent("list"), /Clankie/u);
  await independent("forceload add -16 -16 112 16");
  await independent("fill -16 63 -4 96 63 8 minecraft:stone");
  await independent("fill -4 64 -4 96 68 8 minecraft:air");
  await independent("gamemode survival Clankie");
  await independent("tp Clankie 0.5 64 0.5");
  friend = mineflayer.createBot({
    host: "127.0.0.1",
    port: 25684,
    version: "1.21.4",
    username: "FriendSmoke",
    auth: "offline",
  });
  const chat: { player: string; text: string }[] = [];
  friend.on("chat", (player, text) => {
    chat.push({ player, text });
  });
  await new Promise<void>((done) => friend!.once("spawn", done));
  await independent("tp FriendSmoke 8.5 64 0.5");
  await sleep(500);
  await command("follow", "FriendSmoke", "2");
  await sleep(1800);
  const first = await independent("data get entity Clankie Pos");
  await independent("tp FriendSmoke 15.5 64 0.5");
  await sleep(1800);
  const second = await independent("data get entity Clankie Pos");
  assert.notEqual(first, second, "Continuous follow must react to moving friend");
  await command("cancel");
  await terminal(await command("chat", "minecraft-service-smoke"));
  await waitFor(
    async () => chat,
    (value) =>
      value.some((message) => message.player === "Clankie" && message.text === "minecraft-service-smoke"),
  );
  friend.chat("friend-smoke-event");
  await sleep(200);
  await minecraft.pumpEvents(async (input, guard) => {
    await guard();
    evidence.push({ wake: input });
    return true;
  });
  await independent("tp Clankie 0.5 64 0.5");
  await independent("setblock 2 64 0 minecraft:dirt");
  await sleep(400);
  const dug = await terminal(await command("dig", "2", "64", "0"));
  assert.equal(dug.evidence.outcome, "verified");
  assert.match(await independent("execute if block 2 64 0 minecraft:air"), /Test passed/u);
  await independent("give Clankie minecraft:dirt 8");
  await independent("setblock 3 64 2 minecraft:air");
  await sleep(300);
  const placed = await terminal(await command("place", "3", "64", "2", "dirt"));
  assert.equal(placed.evidence.outcome, "verified");
  assert.match(await independent("execute if block 3 64 2 minecraft:dirt"), /Test passed/u);
  capture = new MinecraftCapture({
    source: minecraft,
    createSink: async () => undefined,
    onFrame: (frame) => {
      frames++;
      void writeFile(
        join(output, "frames", `minecraft-service-${frames}.png`),
        Buffer.from(frame.data, "base64"),
      );
      evidence.push({ frame: { ...frame, data: "<local PNG file>" } });
    },
  });
  await waitFor(
    async () => {
      await capture!.tick();
      return frames;
    },
    (value) => value >= 3,
  );
  await command("leave");
  await waitFor(
    async () => (await command("status")) as MinecraftStatus,
    (value) => value.session?.termination.state === "confirmed",
  );
  assert.equal(leases.status("play"), undefined);
} catch (error) {
  failure = error;
} finally {
  capture?.close();
  friend?.quit();
  await minecraft.close().catch(() => false);
  await host.close();
  app.close();
  await new Promise<void>((done) => server.close(() => done()));
  await sleep(200);
  evidence.push({ finalPlayers: await rcon("list") });
  await writeFile(join(output, "service-smoke-evidence.json"), JSON.stringify(evidence, null, 2));
  await writeFile(
    join(output, "service-smoke.md"),
    `# Minecraft service smoke

${failure ? `FAIL: ${String(failure)}` : `PASS: isolated real HTTP ${routesOnly ? "Minecraft routes" : "app"}, CLI command module, service/MCP ownership, follow/chat/dig/place and three PNG captures.`}

Evidence: service-smoke-evidence.json. No running Clankie service restarted; no model turn, human client, online auth, Activity publication or Discord call tested.
`,
  );
}
if (failure) throw failure;
console.log(`Minecraft service smoke passed; ${frames} PNG frames saved to ${output}/frames`);
