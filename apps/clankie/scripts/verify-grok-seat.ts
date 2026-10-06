/** Opt-in real TUI verification; never part of pnpm check. Supply an existing Grok profile explicitly. */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, realpath, copyFile, writeFile, readFile, rm } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SettingsStore } from "@clankie/settings";
import { FileCredentialStore } from "@clankie/credential-broker";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { createGrokNativeHost } from "../src/captain/grok-native-host.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { createClankieApp } from "../src/app.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";
import { LocalFleetLink } from "../src/local-fleet-link.ts";
import { localFleetProof } from "../src/local-fleet-proof.ts";
import { connectLaneUpstream } from "../../tui/src/command/mcp.ts";
import { verifyNativeMcp } from "./verify-native-mcp.ts";
import { readHerdrSeatTranscript, type HerdrAgentSession } from "../src/captain/herdr-transcript.ts";
import { createFileMemory } from "../src/memory.ts";
import { createCaptainMemory } from "../src/captain-memory.ts";

assert.equal(process.env.HERDR_ENV, "1", "Run from Herdr; only the owned throwaway session is changed");
assert.ok(process.argv[2] && process.argv[3], "Usage: verify-grok-seat OUT.json EXISTING_GROK_HOME");
const output = resolve(process.argv[2]!);
const compatibilityOnly = process.argv.includes("--native-mcp-compatibility");
const profile = await realpath(process.argv[3]!);
const repoRoot = resolve(import.meta.dirname, "../../..");
const root = await realpath(await mkdtemp("/tmp/cl1583-"));
const execute = promisify(execFile);
const session = `vuh1583-${randomUUID().slice(0, 8)}`;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), root, session };
const liveDescriptor = join(process.env.HOME!, ".clankie/links/default-local.json");
const before = await readFile(liveDescriptor).catch(() => undefined);
const path = join(root, "bin");
await mkdir(path);
await mkdir(join(root, ".grok"));
await copyFile(join(profile, "auth.json"), join(root, ".grok/auth.json"));
await writeFile(
  join(root, ".grok/config.toml"),
  "[compat.claude]\nmcps = false\nhooks = false\n[compat.cursor]\nmcps = false\nhooks = false\n",
);
await writeFile(
  join(root, "herdr.toml"),
  'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\n[update]\nversion_check = false\nmanifest_check = false\n',
);
const tsx = await realpath(join(repoRoot, "apps/tui/node_modules/tsx/dist/loader.mjs"));
await writeFile(
  join(path, "clankie"),
  `#!/bin/sh\nexec '${process.execPath}' --import '${tsx}' '${join(repoRoot, "apps/tui/bin/launcher.ts")}' "$@"\n`,
  { mode: 0o700 },
);
// No inherited fleet credentials or owner configuration; only the explicit existing Grok login above.
const env: NodeJS.ProcessEnv = {
  PATH: `${path}:${process.env.PATH}`,
  HOME: root,
  GROK_HOME: join(root, ".grok"),
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_RUNTIME_DIR: root,
  CLANKIE_STATE: join(root, "state"),
  CLANKIE_STATE_HOME: join(root, "state"),
  HERDR_CONFIG_PATH: join(root, "herdr.toml"),
  TERM: "xterm-256color",
  SHELL: "/bin/sh",
  ...Object.fromEntries(
    ["USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR"].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]!]],
    ),
  ),
};
const previous = { ...process.env };
for (const key of Object.keys(process.env))
  if (/^(CLANKIE_|DISCORD_|HERDR_)/u.test(key)) delete process.env[key];
Object.assign(process.env, env);
const herdr = spawn("herdr", ["--session", session, "server"], { env, cwd: root, stdio: "ignore" });
let socketPath: string | undefined;
let captain: ReturnType<typeof createCaptain> | undefined;
let app: Awaited<ReturnType<typeof createClankieApp>> | undefined;
let link: LocalFleetLink | undefined;
const servers: ReturnType<typeof serve>[] = [];
let upstream: Awaited<ReturnType<typeof connectLaneUpstream>> | undefined;
try {
  for (let i = 0; i < 100 && !socketPath; i++) {
    const rows = JSON.parse(
      (await execute("herdr", ["--session", session, "session", "list", "--json"], { env })).stdout,
    ).sessions;
    socketPath = rows.find(
      (row: { name: string; running: boolean }) => row.name === session && row.running,
    )?.socket_path;
    if (!socketPath) await pause(100);
  }
  assert.ok(socketPath, "Owned Herdr server unavailable");
  env.HERDR_SOCKET_PATH = socketPath;
  process.env.HERDR_SOCKET_PATH = socketPath;
  await execute("herdr", ["workspace", "create", "--cwd", root, "--label", "VUH1583", "--no-focus"], { env });
  const binding = async () => ({ runtime: "external" as const, session, socketPath: socketPath! });
  const wire: unknown[] = [];
  evidence.herdrWire = wire;
  const native = createGrokNativeHost({
    binding,
    processHelper: join(repoRoot, "integrations/opencode-plugin/process-birth.py"),
    request: async (binding, method, params) =>
      new Promise((resolve, reject) => {
        const socket = createConnection(binding.socketPath),
          id = randomUUID();
        let text = "";
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error(`Owned Herdr ${method} timeout`));
        }, 10_000);
        socket.on("error", reject);
        socket.on("connect", () => socket.write(JSON.stringify({ id, method, params }) + "\n"));
        socket.on("data", (data) => {
          text += data;
          if (!text.includes("\n")) return;
          clearTimeout(timer);
          socket.destroy();
          const reply = JSON.parse(text.split("\n")[0]!);
          wire.push({ method, reply });
          if (reply.error) reject(new Error(JSON.stringify(reply)));
          else resolve(reply);
        });
      }),
  });
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const mcp = {
    catalog: async () => [],
    call: async () => {
      throw new Error("No external account in verification service");
    },
    account: async () => {
      throw new Error("No external account");
    },
  } as unknown as CaptainDeps["mcp"];
  const memory = createFileMemory({ dataDir: join(root, "memory") });
  memory.recordEpisode({
    schemaVersion: 1,
    episodeId: "vuh1583-fixture",
    lane: "operator",
    targetId: "global-default",
    sourceConversationId: "global-default",
    summary: "VUH1583_MEMORY_SENTINEL",
    visibility: "operator_private",
    retained: true,
    occurredAt: new Date().toISOString(),
    provenance: {
      characterId: "clankie",
      sessionId: "vuh1583-fixture",
      selfAuthored: true,
      rawTranscript: false,
    },
  });
  captain = createCaptain(
    {
      herdrAvailable: () => true,
      embodiment: {},
      browser: { catalog: async () => ({ available: false, tools: [] }) },
      mcp,
      memory: createCaptainMemory(memory),
    } as unknown as CaptainDeps,
    {
      repoRoot,
      stateDir: join(root, "captain"),
      workingDirectory: root,
      settings: new SettingsStore(join(root, "settings.json")),
      grokNative: native,
      nativeHerdrRunner: createHerdrWatchRunner(
        () => true,
        async (args, signal, timeout) =>
          (
            await execute("herdr", [...args], {
              env,
              signal,
              timeout: timeout ?? 30_000,
              maxBuffer: 4 * 1024 * 1024,
            })
          ).stdout,
        native.createCommandTab,
      ),
      nativeCensusRunner: (command, args) =>
        execute(command, [...args], { env, timeout: 10_000, maxBuffer: 4 * 1024 * 1024 }),
    },
  );
  link = new LocalFleetLink({
    directory: join(env.CLANKIE_STATE!, "links"),
    binding,
    prove: localFleetProof({
      binding,
      herdrBinary: "herdr",
      privateSeat: (chain, pane, current) => native.allows(chain, pane, current),
    }),
  });
  const workerMcp = new WorkerMcp({ directory: join(root, "grants"), credentials, host: mcp as never });
  const bearer = `clankie_op_${randomBytes(32).toString("base64url")}`;
  env.CLANKIE_OPERATOR_TOKEN = bearer;
  process.env.CLANKIE_OPERATOR_TOKEN = bearer;
  app = await createClankieApp({
    captain,
    deviceSessionKey: randomBytes(32),
    eventLogPath: join(root, "events.jsonl"),
    localFleet: link,
    workerMcp,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === `Bearer ${bearer}`
        ? { operatorId: "grok-verification" }
        : undefined,
  });
  const boot = async (fetch: Parameters<typeof serve>[0]["fetch"]) => {
    const server = serve({ fetch, hostname: "127.0.0.1", port: 0 });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return address.port;
  };
  const observations: Array<Record<string, unknown>> = [];
  const port = await boot(async (request) => {
    if (request.method === "POST" && new URL(request.url).pathname === "/v1/mcp") {
      const body = await request.clone().json();
      if (body.method === "initialize")
        observations.push({ method: body.method, clientInfo: body.params?.clientInfo });
      if (body.method === "tools/call")
        observations.push({
          method: body.method,
          name: body.params?.name,
          arguments: body.params?.arguments,
        });
    }
    return app!.app.fetch(request);
  });
  const fleetPort = await boot(link.fetch((request) => app!.app.fetch(request)));
  await link.publish(fleetPort);
  const host = `http://127.0.0.1:${port}`;
  env.CLANKIE_CONTROL_PLANE_URL = host;
  process.env.CLANKIE_CONTROL_PLANE_URL = host;
  if (compatibilityOnly) {
    evidence.nativeMcp = await verifyNativeMcp({
      root,
      repoRoot,
      native,
      env,
      ownerHome: previous.HOME!,
      observations,
    });
    evidence.liveDescriptorUnchanged =
      Buffer.compare(
        before ?? Buffer.alloc(0),
        await readFile(liveDescriptor).catch(() => Buffer.alloc(0)),
      ) === 0;
    assert.equal(evidence.liveDescriptorUnchanged, true);
    evidence.outcome = "passed";
  } else {
    upstream = await connectLaneUpstream({ host, bearer });
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await upstream!.callTool(name, args);
      const part = result.content.find((part) => part.type === "text");
      assert.ok(part?.type === "text");
      try {
        return JSON.parse(part.text);
      } catch {
        throw new Error(`${name}: ${part.text}`);
      }
    };
    const hire = await call("hire_agent", {
      harness: "grok",
      title: "Nova",
      role: "developer",
      workingDirectory: root,
      brief: "Reply with exactly VUH1583_HIRE_OK. Do not use tools or change files.",
    });
    evidence.hire = hire;
    assert.equal(hire.outcome, "spawned", JSON.stringify(hire));
    const seatId = hire.seat.seatId;
    const worker = await createHerdrWatchRunner(
      () => true,
      async (args) => (await execute("herdr", [...args], { env })).stdout,
    ).resolveTerminal(seatId);
    assert.ok(worker);
    evidence.worker = worker;
    const waitText = async (pane: string, session: HerdrAgentSession, expected: readonly string[]) => {
      for (let i = 0; i < 300; i++) {
        const transcript = readHerdrSeatTranscript("grok", session);
        if (
          transcript?.entries.some(
            (entry) =>
              entry.type === "message" &&
              entry.role === "agent" &&
              expected.every((marker) => entry.text.includes(marker)),
          )
        ) {
          await pause(1500);
          return {
            transcript,
            tui: (
              await execute(
                "herdr",
                ["pane", "read", pane, "--source", "recent-unwrapped", "--lines", "100"],
                {
                  env,
                },
              )
            ).stdout,
          };
        }
        await pause(200);
      }
      throw new Error(`Native agent transcript output unavailable: ${expected.join(", ")}`);
    };
    assert.ok(worker.session);
    evidence.workerReply = await waitText(worker.paneId, worker.session, ["VUH1583_HIRE_OK"]);
    const message = await call("message_seat", {
      seat: seatId,
      message: "Reply with exactly VUH1583_MESSAGE_OK. Do not use tools.",
    });
    evidence.message = message;
    assert.equal(message.outcome, "delivered", JSON.stringify(message));
    evidence.workerMessageReply = await waitText(worker.paneId, worker.session, ["VUH1583_MESSAGE_OK"]);
    // Real public operator command runs as initial argv in another owned native pane.
    const pane = await native.createCommandTab({
      cwd: root,
      label: "VUH1583 operator",
      command: [join(path, "clankie"), "seat", "--harness", "grok"],
      env: Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
    });
    for (let i = 0; i < 150; i++) {
      const text = (
        await execute("herdr", ["pane", "read", pane, "--source", "recent-unwrapped", "--lines", "50"], {
          env,
        })
      ).stdout;
      if (text.includes("Clankie Grok: native session")) {
        evidence.operatorReadyTui = text;
        break;
      }
      if (i === 149) {
        const record = JSON.parse(await readFile(join(env.CLANKIE_STATE!, "clankie/grok-seat.json"), "utf8"));
        const client = new Client({ name: "grok-verifier", version: "1" });
        try {
          await client.connect(
            new StdioClientTransport({
              command: join(path, "clankie"),
              args: ["mcp", "--lane", "operator"],
              env: { ...env, CLANKIE_CONVERSATION_ID: record.conversationId } as Record<string, string>,
            }),
          );
          const tools = await client.listTools();
          evidence.operatorBridgeTools = tools.tools.map((tool) => ({
            name: tool.name,
            schemaType: tool.inputSchema.type,
          }));
        } catch (error) {
          evidence.operatorBridgeError = String(error);
        } finally {
          await client.close();
        }
        const log = await readFile(join(root, ".grok/logs/unified.jsonl"), "utf8");
        evidence.nativeWarnings = log
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((row) => ["warn", "error"].includes(row.lvl))
          .map((row) => ({ message: row.msg, keys: Object.keys(row.ctx ?? {}) }));
        throw new Error(`Operator not ready: ${text}`);
      }
      await pause(200);
    }
    evidence.operatorRecord = JSON.parse(
      await readFile(join(env.CLANKIE_STATE!, "clankie/grok-seat.json"), "utf8"),
    );
    const record = evidence.operatorRecord as { sessionId: string; conversationId: string };
    await pause(1000); // allow the real operator driver's first outbox poll to bind
    assert.equal(
      await captain.wakeConversation(
        { conversationId: record.conversationId },
        "Owner verification: without using tools, identify yourself, repeat the verification note from your memory card, name a bundled skill you can load and the connected tool you would use to hire a worker. Finish with VUH1583_OPERATOR_OK. Do not change files or start agents.",
        undefined,
        "machine",
        false,
      ),
      true,
    );
    evidence.operatorReply = await waitText(
      pane,
      { source: "herdr:grok", kind: "id", value: record.sessionId },
      ["Clankie", "VUH1583_MEMORY_SENTINEL", "hire_agent", "VUH1583_OPERATOR_OK"],
    );
    evidence.operatorTui = (
      await execute("herdr", ["pane", "read", pane, "--source", "recent-unwrapped", "--lines", "100"], {
        env,
      })
    ).stdout;
    evidence.liveDescriptorUnchanged =
      Buffer.compare(
        before ?? Buffer.alloc(0),
        await readFile(liveDescriptor).catch(() => Buffer.alloc(0)),
      ) === 0;
    assert.equal(evidence.liveDescriptorUnchanged, true);
    evidence.outcome = "passed";
  }
} catch (error) {
  evidence.error = String(error);
  process.exitCode = 1;
  console.error(error);
} finally {
  await upstream?.close();
  await captain?.close();
  app?.close();
  await link?.close();
  for (const server of servers) {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  herdr.kill("SIGTERM");
  await pause(1000);
  // Native leaders persist after TUI exit. Only inspect/stop those owning this unique test directory.
  const leaders = (await execute("/bin/ps", ["-axo", "pid=,args="])).stdout
    .split("\n")
    .filter((line) => /\sagent\s/u.test(line) && /\sleader(?:\s|$)/u.test(line) && line.includes(root));
  evidence.cleanup = [];
  for (const row of leaders) {
    const pid = Number(row.trim().split(/\s/u)[0]);
    const sockets = (await execute("/usr/sbin/lsof", ["-a", "-p", String(pid), "-U", "-Fn"])).stdout;
    const socketPath = /--leader-socket ([^ ]+)/u.exec(row)?.[1];
    if (socketPath && sockets.split("\n").includes(`n${socketPath}`)) {
      process.kill(pid, "SIGTERM");
      (evidence.cleanup as number[]).push(pid);
    }
  }
  evidence.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
  console.log(`Evidence: ${output}`);
  await rm(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, previous);
}
