import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, expect, test } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import {
  MachineJoinLeaseSchema,
  MachineJoinStatusSchema,
  machineJoinLeaseAad,
} from "@clankie/protocol/machine-join";
import { MachineJoins } from "../src/machine-joins.ts";
import { createMachineJoinRoutes } from "../src/machine-join-routes.ts";
import { createJoinedSeats } from "../src/joined-seats.ts";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { joinedHireTools } from "../src/captain/machine-coding-tools.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { logger } from "../src/app/log.ts";
import { machineJoinHash, machineJoinKey } from "../src/machine-join-crypto.ts";
import { openGatewayValue } from "../src/gateway-encryption.ts";
import { runJoinedMachineChannel, saveJoinedMachineCredential } from "../../tui/bin/joined-machine-client.ts";
import { runJoinedSeatHook } from "../../tui/src/command/joined-seat.ts";
import { joinedWorkerPorts } from "../../tui/src/command/joined-worker.ts";
import type { McpCommandOptions } from "../../tui/src/command/mcp.ts";
import type { HeadlessCaptainCommandOptions } from "../../tui/bin/headless-captain.ts";

const exec = promisify(execFile);

// VUH-2607: Clankie's own hire on a joined machine, through the real join registry,
// encrypted channel, receiver and Herdr. Only `claude` is a stand-in: it records its
// launch and reports itself to Herdr as Claude does. The live Claude worker is the
// manual proof (apps/clankie/scripts/prove-joined-hire.ts).
const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

test("Clankie hires a Claude worker on a joined machine at workers, with named refusals", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "joined-hire-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repoRoot = await realpath(join(import.meta.dirname, "../../.."));
  const directory = await realpath(process.cwd());
  const settings = new SettingsStore(join(root, "settings.json"));
  const secrets = new FileCredentialStore(join(root, "home-secrets.json"));
  const local = new FileCredentialStore(join(root, "local-secrets.json"));
  const captain = createCaptain(
    {
      herdrAvailable: () => false,
      presence: { listSessions: async () => [] },
      embodiment: { getLiveSession: async () => undefined },
      browser: { catalog: async () => ({ available: false, tools: [] }) },
      mcp: createMcpHost({ settings, credentials: secrets, logger }),
    } as unknown as CaptainDeps,
    { repoRoot, stateDir: root, settings },
  );
  const joins = new MachineJoins({ settings, secrets, directory: join(root, "joins") });
  const seats = createJoinedSeats({ joins, captain, settings });
  cleanups.push(() => seats.close());
  const relay = new Hono().route(
    "/h/fixture",
    createMachineJoinRoutes(joins, async () => "authentication_required"),
  );
  const server = serve({ fetch: relay.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await new Promise<void>((resolve) => server.once("listening", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/h/fixture`;

  // The owner approves this machine at workers, for one folder.
  const code = randomBytes(32).toString("base64url");
  const claimSecret = randomBytes(32).toString("base64url");
  const ticket = joins.start({
    name: "laptop",
    platform: "darwin",
    directories: [directory],
    claimSecret,
    approvalHash: machineJoinHash(code),
  });
  await joins.approve({ code, accessLevel: "workers", directories: [directory] }, async () => {});
  const status = MachineJoinStatusSchema.parse(joins.status(ticket.joinId, claimSecret));
  if (status.state !== "approved") throw Error("approval failed");
  const credential = {
    origin,
    lease: MachineJoinLeaseSchema.parse(
      JSON.parse(
        openGatewayValue(machineJoinKey(code), status.sealedLease, machineJoinLeaseAad(ticket.joinId)),
      ),
    ),
    localDirectories: [directory],
  };
  await saveJoinedMachineCredential(local, credential);
  const machineId = credential.lease.machineId;
  // A real Herdr namespace (short path: macOS socket limit) whose `claude` is the stand-in.
  const herdrRoot = await mkdtemp("/tmp/joined-hire-");
  cleanups.push(() => rm(herdrRoot, { recursive: true, force: true }));
  await mkdir(join(herdrRoot, "config"), { recursive: true });
  await mkdir(join(herdrRoot, "bin"), { recursive: true });
  await writeFile(
    join(herdrRoot, "config/config.toml"),
    'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\n[update]\nversion_check = false\nmanifest_check = false\n',
  );
  const record = join(herdrRoot, "claude-launch.json");
  await writeFile(
    join(herdrRoot, "bin/claude"),
    `#!${process.execPath}
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ argv, env: process.env }));
execFileSync("herdr", ["pane", "report-agent", process.env.HERDR_PANE_ID, "--source", "herdr:claude", "--agent", "claude",
  "--state", "idle", "--agent-session-id", argv[argv.indexOf("--session-id") + 1]]);
setInterval(() => {}, 1 << 30);
`,
  );
  await chmod(join(herdrRoot, "bin/claude"), 0o755);
  const herdrEnv: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_"))),
    PATH: `${join(herdrRoot, "bin")}:${process.env.PATH}`,
    HERDR_SOCKET_PATH: join(herdrRoot, "herdr.sock"),
    HERDR_CONFIG_PATH: join(herdrRoot, "config/config.toml"),
    XDG_CONFIG_HOME: join(herdrRoot, "config"),
    XDG_STATE_HOME: join(herdrRoot, "state"),
    XDG_DATA_HOME: join(herdrRoot, "data"),
    XDG_CACHE_HOME: join(herdrRoot, "cache"),
    SHELL: "/bin/sh",
    CLANKIE_STATE: join(root, "laptop-state"),
    CLANKIE_CREDENTIALS_FILE: join(root, "local-secrets.json"),
  };
  const herdr = spawn("herdr", ["server"], { env: herdrEnv, stdio: "ignore" });
  cleanups.push(async () => {
    await exec("herdr", ["server", "stop"], { env: herdrEnv }).catch(() => herdr.kill("SIGKILL"));
  });
  await expect.poll(() => existsSync(herdrEnv.HERDR_SOCKET_PATH!), { timeout: 10_000 }).toBe(true);

  let finishFirstTurn = () => {};
  const firstTurn = new Promise<void>((resolve) => (finishFirstTurn = resolve));
  const abort = new AbortController();
  const channel = runJoinedMachineChannel(credential, {
    store: local,
    signal: abort.signal,
    intervalMs: 10,
    // The joined machine's own workers adapter, as `clankie join` runs it.
    ports: {
      workers: joinedWorkerPorts(credential, {
        env: herdrEnv,
        // Real Herdr, but its answer to `agent start` is held, as Herdr holds it
        // until a briefed Claude finishes its first turn.
        run: async (args, signal) => {
          const { stdout } = await exec("herdr", [...args], { env: herdrEnv, ...(signal ? { signal } : {}) });
          if (args[0] === "agent" && args[1] === "start") await firstTurn;
          return stdout;
        },
      }),
    },
  });
  cleanups.push(async () => {
    abort.abort();
    await channel.catch(() => undefined);
  });

  // The captain's own hire_agent and message_seat, wrapped for joined targets.
  const originalCalls: string[] = [];
  const base = ["hire_agent", "message_seat"].map((name) => ({
    name,
    description: name,
    execute: async () => {
      originalCalls.push(name);
      return { content: [{ type: "text" as const, text: "original" }], details: {} };
    },
  }));
  const turn = { autonomous: false as boolean | undefined };
  const [hire] = joinedHireTools(base, joins, settings, { conversationId: "global-default", turn });
  const call = async (params: Record<string, unknown>) =>
    (
      await (hire!.execute as (id: string, params: Record<string, unknown>) => Promise<{ details: unknown }>)(
        "call",
        params,
      )
    ).details as Record<string, unknown>;
  const request = {
    title: "Wren",
    role: "worker",
    fleet: machineId,
    workingDirectory: directory,
    brief: "Write proof.txt and report back.",
  };

  // The worker reports inside its first turn, before Herdr answers `agent start`:
  // admission must not wait for that answer.
  const hiring = call(request);
  await expect.poll(() => existsSync(record), { timeout: 20_000 }).toBe(true);

  // Herdr accepted the launch (agent name, shell-encodable arguments).
  const launched = JSON.parse(await readFile(record, "utf8")) as { argv: string[]; env: NodeJS.ProcessEnv };
  expect(launched.argv.some((argument) => /\p{Cc}/u.test(argument))).toBe(false);
  const briefPath = /@(\S+)$/u.exec(launched.argv.at(-1)!)?.[1];
  expect(briefPath).toBeDefined();
  expect((await stat(briefPath!)).mode & 0o777).toBe(0o600);
  const staged = JSON.parse(await readFile(briefPath!, "utf8")) as { clankieBrief: string };
  expect(staged.clankieBrief).toContain(request.brief);
  expect(launched.env.CLANKIE_OPERATOR_TOKEN).toBe("");

  // The worker plugin's bridge in that pane serves message_clankie over the join channel.
  const [harness, bridge] = InMemoryTransport.createLinkedPair();
  // `clankie mcp` takes its stdio transport through the same options the hook routes.
  const bridgeOptions: HeadlessCaptainCommandOptions & McpCommandOptions = {
    repoRoot,
    env: {
      ...launched.env,
      CLANKIE_CREDENTIALS_FILE: herdrEnv.CLANKIE_CREDENTIALS_FILE,
      CLANKIE_SEAT_PARENT_ARGV: "claude --channels plugin:clankie-worker@clankie",
    },
    transport: bridge,
    stderr: { write: () => true },
  };
  const bridged = runJoinedSeatHook("mcp", ["--seat"], bridgeOptions);
  const client = new Client({ name: "worker", version: "1" }, { capabilities: {} });
  await client.connect(harness);
  expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(["message_clankie", "message_clankie_status"]),
  );
  const deliveryId = randomUUID();
  const reported = await client.callTool({
    name: "message_clankie",
    arguments: { text: "Wren: proof.txt written.", deliveryId },
  });
  expect(reported.isError).not.toBe(true);
  const receipt = await client.callTool({ name: "message_clankie_status", arguments: { deliveryId } });
  expect(JSON.stringify(receipt.content)).not.toContain('"unknown"');
  await client.close();
  await bridged;

  // The receiver admitted the native session Claude reported (agent_session).
  const started = await hiring;
  expect(started).toMatchObject({ outcome: "started", conversationId: "global-default" });
  const seat = String(started.seatId);
  expect(seat).toMatch(new RegExp(`^${machineId}/w\\d+:p\\d+$`, "u"));
  expect(staged.clankieBrief).toContain(`Your seat is ${seat}.`);
  finishFirstTurn();

  // Named refusals: a folder not approved at join, another harness, an autonomous turn, a level below workers.
  expect(await call({ ...request, workingDirectory: "/tmp" })).toMatchObject({
    outcome: "failed",
    reason: "unknown_directory",
  });
  expect(await call({ ...request, harness: "codex" })).toMatchObject({
    outcome: "failed",
    reason: "harness_unavailable",
  });
  turn.autonomous = true;
  await expect(call(request)).rejects.toThrow("only in a turn the owner started");
  turn.autonomous = false;
  await settings.update((current) => ({
    ...current,
    machineAccess: { ...current.machineAccess, [machineId]: "portal" },
  }));
  await expect(call(request)).rejects.toThrow(/portal.*workers/u);

  // Every other target is the ordinary hire.
  await call({ ...request, fleet: undefined });
  expect(originalCalls).toEqual(["hire_agent"]);
});
