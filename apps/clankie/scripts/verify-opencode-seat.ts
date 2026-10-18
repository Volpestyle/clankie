/**
 * Opt-in real OpenCode worker verification; never part of pnpm check. Hires the
 * installed OpenCode through the real hire path into an owned Herdr session and a
 * scratch service on ephemeral loopback ports. Supply the existing OpenCode data
 * directory explicitly; only its auth.json is copied.
 *
 *   pnpm -C apps/clankie verify-opencode-seat OUT.json ~/.local/share/opencode [provider/model]
 */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, realpath, copyFile, writeFile, readFile, rm } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { serve } from "@hono/node-server";
import { SettingsStore } from "@clankie/settings";
import { FileCredentialStore } from "@clankie/credential-broker";
import { createCaptain } from "../src/captain/captain.ts";
import type { CaptainDeps } from "../src/captain/deps.ts";
import { createOpenCodeNativeHost } from "../src/captain/opencode-native-host.ts";
import { createHerdrWatchRunner } from "../src/captain/herdr-watch.ts";
import { createClankieApp } from "../src/app.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";
import { LocalFleetLink } from "../src/local-fleet-link.ts";
import { localFleetProof } from "../src/local-fleet-proof.ts";
import { OpenCodeProfiles } from "../src/opencode-profiles.ts";
import { connectLaneUpstream } from "../../tui/src/command/mcp.ts";
import { decodeMcpResult } from "@clankie/protocol/mcp-result";

assert.equal(process.env.HERDR_ENV, "1", "Run from Herdr; only the owned throwaway session is changed");
assert.ok(
  process.argv[2] && process.argv[3],
  "Usage: verify-opencode-seat OUT.json EXISTING_OPENCODE_DATA_DIR [provider/model]",
);
const output = resolve(process.argv[2]!);
const profile = await realpath(process.argv[3]!);
const model = process.argv[4] ?? "openai/gpt-6-sol";
const repoRoot = resolve(import.meta.dirname, "../../..");
const root = await realpath(await mkdtemp("/tmp/vuh2417-opencode-"));
const execute = promisify(execFile);
const session = `vuh2417-${randomUUID().slice(0, 8)}`;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const proofDiagnostics: unknown[] = [];
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), root, session, model };
evidence.proofDiagnostics = proofDiagnostics;
const liveDescriptor = join(process.env.HOME!, ".clankie/links/default-local.json");
const before = await readFile(liveDescriptor).catch(() => undefined);
const path = join(root, "bin");
await mkdir(path);
await mkdir(join(root, ".local/share/opencode"), { recursive: true });
await mkdir(join(root, ".config/opencode"), { recursive: true });
await copyFile(join(profile, "auth.json"), join(root, ".local/share/opencode/auth.json"));
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
// No inherited fleet credentials or owner configuration; only the explicit existing OpenCode login above.
const env: NodeJS.ProcessEnv = {
  PATH: `${path}:${process.env.PATH}`,
  HOME: root,
  // Herdr installs its OpenCode integration under HOME/.config; OpenCode must read the same directory.
  XDG_CONFIG_HOME: join(root, ".config"),
  XDG_DATA_HOME: join(root, ".local/share"),
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
evidence.opencodeVersion = (await execute("opencode", ["--version"], { env })).stdout.trim();
// Herdr anchors an OpenCode session only from its own OpenCode integration, as on
// an owner's machine; Clankie's prepared report must then match that session.
evidence.herdrIntegration = (
  await execute("herdr", ["integration", "install", "opencode"], { env })
).stdout.trim();
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
  await execute("herdr", ["workspace", "create", "--cwd", root, "--label", "VUH2417", "--no-focus"], { env });
  const binding = async () => ({ runtime: "external" as const, session, socketPath: socketPath! });
  const native = createOpenCodeNativeHost({
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
          if (reply.error) reject(new Error(JSON.stringify(reply)));
          else resolve(reply);
        });
      }),
  });
  const mcp = {
    catalog: async () => [],
    call: async () => {
      throw new Error("No external account in verification service");
    },
    account: async () => {
      throw new Error("No external account");
    },
  } as unknown as CaptainDeps["mcp"];
  // The scratch owner turns on maximum trust: the worker's own message_clankie
  // call must not wait on a native permission prompt nobody is here to answer.
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({ ...current, maximumTrustMode: true }));
  const stateDir = join(root, "captain");
  captain = createCaptain(
    {
      herdrAvailable: () => true,
      embodiment: {},
      browser: { catalog: async () => ({ available: false, tools: [] }) },
      mcp,
    } as unknown as CaptainDeps,
    {
      repoRoot,
      stateDir,
      workingDirectory: root,
      settings,
      openCodeNative: native,
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
      // Proof stages only (pids, reasons), so a refused bridge is diagnosable.
      diagnostics: (event, pane) => {
        if (proofDiagnostics.length < 200) proofDiagnostics.push({ pane, event });
      },
    }),
  });
  const workerMcp = new WorkerMcp({
    directory: join(root, "grants"),
    credentials: new FileCredentialStore(join(root, "credentials.json")),
    host: mcp as never,
  });
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
        ? { operatorId: "opencode-verification" }
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
  const port = await boot((request) => app!.app.fetch(request));
  const fleetPort = await boot(link.fetch((request) => app!.app.fetch(request)));
  await link.publish(fleetPort);
  evidence.ports = { service: port, fleet: fleetPort };
  const host = `http://127.0.0.1:${port}`;
  env.CLANKIE_CONTROL_PLANE_URL = host;
  process.env.CLANKIE_CONTROL_PLANE_URL = host;
  upstream = await connectLaneUpstream({ host, bearer });
  // Tool text is a readable summary; the result itself is structured content.
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await upstream!.callTool(name, args);
    const value = decodeMcpResult(result);
    if (typeof value !== "object" || value === null)
      throw new Error(`${name}: ${JSON.stringify(result.content).slice(0, 2000)}`);
    return value as any;
  };
  const tui = async (pane: string) =>
    (
      await execute("herdr", ["pane", "read", pane, "--source", "recent-unwrapped", "--lines", "100"], {
        env,
      })
    ).stdout;
  const hire = await call("hire_agent", {
    harness: "opencode",
    title: "Nova",
    role: "developer",
    workingDirectory: root,
    model,
    effort: "low",
    effortReason: "A fixed two-step verification reply needs no deeper reasoning.",
    brief:
      "Verification only; do not change files. First call the message_clankie tool once with the exact text " +
      "VUH2417_OPENCODE_REPORT. Then end your turn by replying with exactly VUH2417_OPENCODE_DONE.",
  });
  evidence.hire = hire;
  assert.equal(hire.outcome, "spawned", JSON.stringify(hire));
  const seatId = (hire.seat?.seatId ?? hire.seatId) as string;
  const worker = await createHerdrWatchRunner(
    () => true,
    async (args) => (await execute("herdr", [...args], { env })).stdout,
  ).resolveTerminal(seatId);
  assert.ok(worker?.session && worker.session.kind === "id");
  evidence.worker = worker;
  const sessionId = worker.session.value;
  const profiles = new OpenCodeProfiles(stateDir);
  // Stored native history through the registered dedicated profile: the real
  // reader against the installed release's database. A final assistant reply
  // carrying the marker is this turn's completion.
  const waitReply = async (marker: string) => {
    for (let i = 0; i < 600; i++) {
      const page = await profiles.read(sessionId, { tail: 50 }).catch(() => undefined);
      const reply = page?.entries.find(
        (entry) => entry.type === "message" && entry.role === "agent" && entry.text.includes(marker),
      );
      if (reply) return { reply, title: page!.title, source: page!.source, tui: await tui(worker.paneId) };
      await pause(500);
    }
    throw new Error(`Native stored reply unavailable: ${marker}`);
  };
  evidence.hireReply = await waitReply("VUH2417_OPENCODE_DONE");
  for (let i = 0; i < 120; i++) {
    const reports = await call("worker_reports", { limit: 20 });
    if (JSON.stringify(reports).includes("VUH2417_OPENCODE_REPORT")) {
      evidence.workerReports = reports;
      break;
    }
    await pause(500);
  }
  assert.ok(evidence.workerReports, "Worker report never reached the hiring conversation");
  for (let i = 0; i < 120; i++) {
    const fleet = await captain.serveOperatorConversation({ op: "fleet", schemaVersion: 1 });
    const seat =
      fleet.op === "fleet" ? fleet.snapshot.seats.find((candidate) => candidate.seatId === seatId) : undefined;
    // The stored final reply above is OpenCode's own completion; the roster must
    // also show the seat settled (a run outcome when it observed the working state).
    if (seat?.lastOutcome || seat?.status === "done" || seat?.status === "idle") {
      evidence.completion = { status: seat.status, lastOutcome: seat.lastOutcome };
      break;
    }
    await pause(500);
  }
  assert.ok(evidence.completion, "Roster never recorded the settled run");
  const message = await call("message_seat", {
    seat: seatId,
    message: "Reply with exactly VUH2417_OPENCODE_MESSAGE_OK. Do not use tools.",
  });
  evidence.message = message;
  // The native reply below proves delivery; this only refuses an outright failure.
    assert.ok(
      ["delivered", "accepted", "queued"].includes(message.outcome) ||
        ["delivered", "consumed"].includes(message.deliveryStage),
      JSON.stringify(message),
    );
  evidence.messageReply = await waitReply("VUH2417_OPENCODE_MESSAGE_OK");
  // Recorded, not asserted: retirement also involves tracker policy outside this check.
  evidence.close = await call("close_worker_pane", {
    pane: worker.paneId,
    reason: "VUH-2417 verification finished",
  }).catch((error: unknown) => ({ error: String(error) }));
  evidence.paneAfterClose = await tui(worker.paneId).catch((error: unknown) => String(error));
  evidence.liveDescriptorUnchanged =
    Buffer.compare(before ?? Buffer.alloc(0), await readFile(liveDescriptor).catch(() => Buffer.alloc(0))) ===
    0;
  assert.equal(evidence.liveDescriptorUnchanged, true);
  evidence.outcome = "passed";
} catch (error) {
  evidence.error = String(error);
  process.exitCode = 1;
  // A failed hire names its pane; keep what the native TUI showed.
  const pane = /inspect pane (\S+?);/u.exec(String(error))?.[1];
  if (pane)
    evidence.failedPane = await execute(
      "herdr",
      ["pane", "read", pane, "--source", "recent-unwrapped", "--lines", "100"],
      { env },
    ).then(
      (result) => result.stdout,
      (failure: unknown) => String(failure),
    );
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
  // Only native processes started inside this unique scratch directory.
  const leftovers = (await execute("/bin/ps", ["-axo", "pid=,args="])).stdout
    .split("\n")
    .filter((line) => /opencode/u.test(line) && line.includes(root));
  evidence.cleanup = [];
  for (const row of leftovers) {
    const pid = Number(row.trim().split(/\s/u)[0]);
    process.kill(pid, "SIGTERM");
    (evidence.cleanup as number[]).push(pid);
  }
  evidence.finishedAt = new Date().toISOString();
  await writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
  console.log(`Evidence: ${output}`);
  await rm(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, previous);
}
