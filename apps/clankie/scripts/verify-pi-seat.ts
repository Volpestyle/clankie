/**
 * Opt-in live verification of a native Pi hire on the installed Pi release
 * (VUH-2417); never part of pnpm check. A throwaway service, Herdr session and
 * Pi profile run in a temporary root. Only the selected provider's entry is
 * copied, read-only, from an existing Pi profile's auth.json, so the owner's
 * credentials, sessions and live fleet are never written.
 *
 *   pnpm --filter @clankie/clankie verify-pi-seat OUT.json EXISTING_PI_AGENT_DIR PROVIDER/MODEL
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import { SettingsStore } from "@clankie/settings";
import { FileCredentialStore } from "@clankie/credential-broker";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { createPreparedNativeHost } from "../src/captain/prepared-native-host.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { readHerdrSeatTranscript, type HerdrAgentSession } from "../src/captain/herdr-transcript.ts";
import { supportedPiOnPath } from "../src/captain/pi-native-capability.ts";
import { ownerPath } from "../src/integrate-environment.ts";
import { createClankieApp } from "../src/app.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";
import { LocalFleetLink } from "../src/local-fleet-link.ts";
import { localFleetProof } from "../src/local-fleet-proof.ts";
import { connectLaneUpstream } from "../../tui/src/command/mcp.ts";
import { decodeMcpResult } from "@clankie/protocol/mcp-result";
import { createFileMemory } from "../src/memory.ts";
import { createCaptainMemory } from "../src/captain-memory.ts";

assert.equal(process.env.HERDR_ENV, "1", "Run from Herdr; only the owned throwaway session is changed");
const [outArg, profileArg, model] = process.argv.slice(2);
assert.ok(
  outArg && profileArg && model?.includes("/"),
  "Usage: verify-pi-seat OUT.json PI_AGENT_DIR PROVIDER/MODEL",
);
const output = resolve(outArg);
const provider = model.slice(0, model.indexOf("/"));
const repoRoot = resolve(import.meta.dirname, "../../..");
const root = await realpath(await mkdtemp("/tmp/vuh-2417-pi-"));
const work = join(root, "work");
const agentDir = join(root, ".pi/agent");
const execute = promisify(execFile);
const session = `vuh-2417-pi-${randomUUID().slice(0, 8)}`;
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), root, session, model };
const liveDescriptor = join(process.env.HOME!, ".clankie/links/default-local.json");
// allow-swallowed-rejection -- no live descriptor is a valid before-state
// allow-swallowed-rejection -- an unreadable transcript is retried on the next poll
const before = await readFile(liveDescriptor).catch(() => undefined);

const ownerAuth = JSON.parse(await readFile(join(profileArg, "auth.json"), "utf8")) as Record<
  string,
  { type?: string; expires?: number }
>;
const credential = ownerAuth[provider];
assert.ok(credential, `No ${provider} credential in the existing Pi profile`);
// A refresh would rotate the owner's token from a copy; only use one that needs none.
assert.ok(
  credential.type !== "oauth" || (credential.expires ?? 0) > Date.now() + 3_600_000,
  `${provider} OAuth would need a refresh; refresh it in Pi first`,
);
await mkdir(work, { recursive: true });
await mkdir(join(agentDir, "bin"), { recursive: true });
await mkdir(join(root, "bin"));
// pnpm puts this checkout's bundled Pi SDK shim first; the hire uses the owner's own Pi.
const ownerBin = ownerPath(process.env.PATH)!;
const installed = await supportedPiOnPath({ PATH: ownerBin });
evidence.installedPi = { version: installed.version, cli: installed.cli, node: installed.executable };
await writeFile(join(agentDir, "auth.json"), JSON.stringify({ [provider]: credential }), { mode: 0o600 });
await writeFile(
  join(agentDir, "settings.json"),
  JSON.stringify({
    lastChangelogVersion: installed.version,
    theme: "dark",
    defaultProvider: provider,
    defaultModel: model.slice(provider.length + 1),
  }),
);
await writeFile(join(agentDir, "trust.json"), JSON.stringify({ [work]: true }));
// An established profile already holds Pi's ripgrep; a fresh one would download it during startup.
// allow-swallowed-rejection -- the bundled rg is optional; Pi falls back to PATH
await copyFile(join(profileArg, "bin/rg"), join(agentDir, "bin/rg")).catch(() => {});
await writeFile(
  join(root, "herdr.toml"),
  'onboarding = false\n[terminal]\ndefault_shell = "/bin/sh"\n[update]\nversion_check = false\nmanifest_check = false\n',
);
const tsx = await realpath(join(repoRoot, "apps/tui/node_modules/tsx/dist/loader.mjs"));
// The worker's fleet consumer starts `clankie mcp --fleet`; this checkout's launcher serves it.
await writeFile(
  join(root, "bin/clankie"),
  `#!/bin/sh\nexec '${process.execPath}' --import '${tsx}' '${join(repoRoot, "apps/tui/bin/launcher.ts")}' "$@"\n`,
  { mode: 0o700 },
);
// No inherited fleet credentials or owner configuration; only the copied credential above.
const env: NodeJS.ProcessEnv = {
  PATH: `${join(root, "bin")}:${ownerBin}`,
  HOME: root,
  PI_CODING_AGENT_DIR: agentDir,
  PI_TELEMETRY: "0",
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
  if (/^(CLANKIE_|DISCORD_|HERDR_|PI_)/u.test(key)) delete process.env[key];
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
  await execute("herdr", ["workspace", "create", "--cwd", work, "--label", "VUH2417", "--no-focus"], { env });
  const binding = async () => ({ runtime: "external" as const, session, socketPath: socketPath! });
  const native = createPreparedNativeHost({
    harness: "pi",
    binding,
    processHelper: join(repoRoot, "integrations/opencode-plugin/process-birth.py"),
    request: async (current, method, params) =>
      new Promise((done, fail) => {
        const socket = createConnection(current.socketPath);
        const id = randomUUID();
        let text = "";
        const timer = setTimeout(() => {
          socket.destroy();
          fail(new Error(`Owned Herdr ${method} timeout`));
        }, 10_000);
        socket.on("error", fail);
        socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
        socket.on("data", (data) => {
          text += data;
          if (!text.includes("\n")) return;
          clearTimeout(timer);
          socket.destroy();
          const reply = JSON.parse(text.split("\n")[0]!);
          if (reply.error) fail(new Error(JSON.stringify(reply)));
          else done(reply);
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
  const stateDir = join(root, "captain");
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
      stateDir,
      workingDirectory: work,
      settings: new SettingsStore(join(root, "settings.json")),
      piNative: native,
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
  const proofEvents: Array<Record<string, unknown>> = [];
  evidence.fleetProof = proofEvents;
  link = new LocalFleetLink({
    directory: join(env.CLANKIE_STATE!, "links"),
    binding,
    prove: localFleetProof({
      binding,
      herdrBinary: "herdr",
      diagnostics: (event, pane) => proofEvents.push({ pane, ...event }),
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
        ? { operatorId: "pi-verification" }
        : undefined,
  });
  const boot = async (fetch: Parameters<typeof serve>[0]["fetch"]) => {
    const server = serve({ fetch, hostname: "127.0.0.1", port: 0 });
    servers.push(server);
    await new Promise<void>((done, fail) => {
      server.once("listening", done);
      server.once("error", fail);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return address.port;
  };
  // The worker's own fleet MCP calls, as the service received them.
  const fleetCalls: Array<Record<string, unknown>> = [];
  evidence.fleetCalls = fleetCalls;
  const port = await boot((request) => app!.app.fetch(request));
  const fleetPort = await boot(
    link.fetch(async (request) => {
      const path = new URL(request.url).pathname;
      const body =
        request.method === "POST"
          ? await request
              .clone()
              .json()
              // allow-swallowed-rejection -- an unreadable transcript is retried on the next poll
              .catch(() => undefined)
          : undefined;
      const response = await app!.app.fetch(request);
      fleetCalls.push({
        path,
        status: response.status,
        ...(body?.method === undefined ? { httpMethod: request.method } : { method: body.method }),
        // The fleet bridge serves message_clankie itself and posts the report here.
        ...(/^\/v1\/fleet\/seats\/[^/]+\/messages$/u.test(path) && request.method === "POST" ? { body } : {}),
      });
      return response;
    }),
  );
  await link.publish(fleetPort);
  const host = `http://127.0.0.1:${port}`;
  env.CLANKIE_CONTROL_PLANE_URL = host;
  process.env.CLANKIE_CONTROL_PLANE_URL = host;
  upstream = await connectLaneUpstream({ host, bearer });
  const call = async (name: string, args: Record<string, unknown>) =>
    decodeMcpResult(await upstream!.callTool(name, args)) as Record<string, any>;
  evidence.accounts = await call("worker_accounts", {});
  const hire = await call("hire_agent", {
    harness: "pi",
    title: "Pim",
    role: "developer",
    workingDirectory: work,
    model,
    effort: "low",
    effortReason: "A one-line verification reply needs no reasoning.",
    brief:
      "Verification hire. First call your message_clankie tool once with the text VUH2417_REPORT_OK. " +
      "Then reply with exactly VUH2417_HIRE_OK. Do not change files or run commands.",
  });
  evidence.hire = hire;
  if (hire.outcome !== "spawned") {
    // What the native pane showed when the hire did not start.
    const panes = JSON.parse((await execute("herdr", ["pane", "list"], { env })).stdout).result.panes;
    evidence.panes = await Promise.all(
      panes.map(async (pane: { pane_id: string }) => ({
        ...pane,
        tui: (
          await execute(
            "herdr",
            ["pane", "read", pane.pane_id, "--source", "recent-unwrapped", "--lines", "80"],
            { env },
          )
        ).stdout,
      })),
    );
  }
  assert.equal(hire.outcome, "spawned", JSON.stringify(hire));
  const worker = await createHerdrWatchRunner(
    () => true,
    async (args) => (await execute("herdr", [...args], { env })).stdout,
  ).resolveTerminal(hire.seat.seatId);
  assert.ok(worker?.session);
  evidence.worker = worker;
  const waitText = async (pane: string, agent: HerdrAgentSession, marker: string) => {
    for (let i = 0; i < 600; i++) {
      const transcript = readHerdrSeatTranscript("pi", agent);
      if (
        transcript?.entries.some(
          (entry) => entry.type === "message" && entry.role === "agent" && entry.text.includes(marker),
        )
      ) {
        await pause(1500);
        return {
          transcript,
          tui: (
            await execute("herdr", ["pane", "read", pane, "--source", "recent-unwrapped", "--lines", "80"], {
              env,
            })
          ).stdout,
        };
      }
      await pause(200);
    }
    evidence.unavailableTui = (
      await execute("herdr", ["pane", "read", pane, "--source", "recent-unwrapped", "--lines", "120"], {
        env,
      })
    ).stdout;
    evidence.unavailableTranscript = readHerdrSeatTranscript("pi", agent)?.entries.slice(-12);
    throw new Error(`Native Pi transcript output unavailable: ${marker}`);
  };
  evidence.workerReply = await waitText(worker.paneId, worker.session, "VUH2417_HIRE_OK");
  evidence.report = fleetCalls.find(
    (entry) => entry.status === 200 && JSON.stringify(entry.body ?? null).includes("VUH2417_REPORT_OK"),
  );
  assert.ok(evidence.report, "The worker's message_clankie report did not reach the service");
  const message = await call("message_seat", {
    seat: hire.seat.seatId,
    message: "Reply with exactly VUH2417_MESSAGE_OK. Do not use tools.",
  });
  evidence.message = message;
  assert.equal(message.outcome, "delivered", JSON.stringify(message));
  evidence.workerMessageReply = await waitText(worker.paneId, worker.session, "VUH2417_MESSAGE_OK");
  // The service's own harvest of the native completion, read from its durable state.
  const stateText = async () => {
    const texts: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (/\.(json|jsonl)$/u.test(entry.name))
          texts.push(await readFile(path, "utf8").catch(() => ""));
      }
    };
    await walk(stateDir);
    return texts;
  };
  for (let i = 0; i < 150; i++) {
    const texts = await stateText();
    evidence.completionHarvested = texts.some((text) => text.includes("harvestedTurns"));
    evidence.reportStored = texts.some((text) => text.includes("VUH2417_REPORT_OK"));
    if (evidence.completionHarvested && evidence.reportStored) break;
    await pause(200);
  }
  evidence.watches = JSON.parse(
    await readFile(join(stateDir, "herdr-watches.json"), "utf8").catch(() => "null"),
  );
  assert.equal(evidence.reportStored, true, "The worker report was not stored by the service");
  assert.equal(evidence.completionHarvested, true, "The service did not harvest the native completion");
  evidence.liveDescriptorUnchanged =
    Buffer.compare(before ?? Buffer.alloc(0), await readFile(liveDescriptor).catch(() => Buffer.alloc(0))) ===
    0;
  assert.equal(evidence.liveDescriptorUnchanged, true);
  evidence.outcome = "passed";
} catch (error) {
  evidence.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
  console.error(error);
} finally {
  await upstream?.close();
  await captain?.close();
  app?.close();
  await link?.close();
  for (const server of servers) {
    if ("closeAllConnections" in server) server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
  herdr.kill("SIGTERM");
  await pause(1000);
  evidence.finishedAt = new Date().toISOString();
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`Evidence: ${output}`);
  await rm(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, previous);
}
