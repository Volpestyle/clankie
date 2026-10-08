import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { homedir } from "node:os";
import { HerdrSshTransportSchema, type HerdrSshTransport } from "@clankie/settings";
import {
  createHerdrFleetRun,
  remoteProgramCommand,
  splitFleetQualified,
  powershellLiteral,
  powershellScriptCommand,
} from "../../../clankie/src/herdr-fleet.ts";
import { runRuntimeCommand } from "../command/runtime.ts";
import {
  readTerminalCatalog,
  parseHerdrAgentList,
  occupantIdForHerdrSession,
} from "../../../clankie/src/captain/herdr-census.ts";
import {
  createCaptainOperatorConversationClient,
  createCaptainRouteClient,
} from "./operator-conversations.ts";
import { ClankieApiClient } from "@clankie/api-client";
import {
  resolveCaptainCredential,
  resolveOperatorCredential,
  type CredentialStore,
} from "@clankie/credential-broker";
import {
  HerdrBindingSchema,
  type HerdrBinding,
  type OperatorTerminalSession,
  type OperatorFleetSeat,
} from "@clankie/protocol";

export interface HerdrConnectionOptions {
  readonly repoRoot: string;
  readonly connectionId?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
}

export async function readHerdrBinding(options: HerdrConnectionOptions): Promise<HerdrBinding> {
  const env = options.env ?? process.env;
  const host =
    options.host ?? env.CLANKIE_CONTROL_PLANE_URL ?? env.CLANKIE_CAPTAIN_URL ?? "http://127.0.0.1:4310";
  // A Unix socket belongs to this machine. Remote terminal transport is a separate API.
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(host).hostname)) {
    throw new Error("Herdr's native viewer requires a local Clankie service");
  }
  const credential = await resolveOperatorCredential({
    env,
    ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
  });
  if (!credential) throw new Error("Clankie's operator credential is unavailable");
  return new ClankieApiClient({
    baseUrl: host,
    operatorToken: credential.token,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  }).getHerdrBinding(options.connectionId);
}

/** Route every native fleet action using the running service, never pending settings. */
export function herdrConnection(binding: HerdrBinding, options: HerdrConnectionOptions) {
  HerdrBindingSchema.parse(binding);
  const caller = options.env ?? process.env;
  const env = { ...caller };
  for (const name of Object.keys(env))
    if (name.startsWith("HERDR_") || name.startsWith("HERD_LEAD_")) delete env[name];
  env.HERDR_SOCKET_PATH = binding.socketPath;
  if (caller.HERDR_SOCKET_PATH === binding.socketPath) {
    for (const name of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HERDR_TAB_ID"]) {
      if (caller[name]) env[name] = caller[name];
    }
  }
  let command = "herdr";
  if (binding.runtime === "bundled") {
    command = join(
      options.repoRoot,
      existsSync(join(options.repoRoot, "release.json")) ? "libexec/herdr" : ".data/herdr/bin/herdr",
    );
    const root = dirname(binding.socketPath);
    const activeBinary = join(root, "bin/herdr");
    if (existsSync(activeBinary)) command = activeBinary;
    env.XDG_CONFIG_HOME = root;
    env.XDG_STATE_HOME = root;
    env.XDG_RUNTIME_DIR = root;
    env.HERDR_PLUGIN_STATE_DIR = join(root, "herdr/plugins/herd-lead");
    env.PATH = `${dirname(command)}${delimiter}${env.PATH ?? ""}`;
  }
  return { command, env };
}

/** Attach only: `client` cannot start or stop the service's Herdr server. */
/**
 * Run a Herdr command against the fleet's own runtime: its binary, its socket,
 * its private configuration ([ADR 0164](../../../../docs/adr/0164-the-fleet-is-its-own-session.md)).
 * A bundled fleet is a different build from whatever `herdr` sits on the
 * caller's PATH, which answers a protocol mismatch, and it listens on a socket
 * that PATH knows nothing about. Pane identity rides along only when the caller
 * is already sitting in that session, which `herdrConnection` decides.
 */
export async function runFleetHerdr(
  args: readonly string[],
  options: HerdrConnectionOptions,
): Promise<number> {
  if (options.connectionId) {
    const inventory = await runRuntimeCommand(["list"], options);
    const connections = inventory.connections as Array<{
      id: string;
      enabled: boolean;
      session?: string;
      ssh?: unknown;
    }>;
    const remote = connections.find((entry) => entry.id === options.connectionId && entry.enabled);
    if (remote?.ssh !== undefined) {
      if (!remote.session) throw new Error("Remote fleet is missing its session");
      const run = createHerdrFleetRun(
        {
          id: remote.id,
          session: remote.session,
          ssh: HerdrSshTransportSchema.parse(remote.ssh),
        },
        { controlDirectory: join(options.env?.HOME ?? homedir(), ".clankie", "ssh") },
      );
      const stdout = await run(args);
      process.stdout.write(isAgentList(args) ? await withFleetAgentHealth(stdout, options) : stdout);
      return 0;
    }
  }
  const { command, env } = herdrConnection(await readHerdrBinding(options), options);
  if (isAgentList(args)) {
    const { stdout, stderr } = await promisify(execFile)(command, [...args], {
      env,
      timeout: 5_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (stderr) process.stderr.write(stderr);
    process.stdout.write(await withFleetAgentHealth(stdout, options));
    return 0;
  }
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(command, [...args], { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

function isAgentList(args: readonly string[]): boolean {
  return args[0] === "agent" && args[1] === "list" && args.slice(2).every((arg) => arg === "--json");
}

/** Preserve native list fields; add only observations for the exact occupying session. */
export async function withFleetAgentHealth(stdout: string, options: HerdrConnectionOptions): Promise<string> {
  try {
    const native = parseHerdrAgentList(stdout);
    const parsed = JSON.parse(stdout) as { result?: { agents?: unknown[] } };
    if (!Array.isArray(parsed.result?.agents)) return stdout;
    const env = options.env ?? process.env;
    const credential = await resolveCaptainCredential({
      env,
      ...(options.operatorCredentialStore ? { store: options.operatorCredentialStore } : {}),
    });
    if (!credential) return stdout;
    const client = createCaptainOperatorConversationClient(
      createCaptainRouteClient({
        host:
          options.host ?? env.CLANKIE_CONTROL_PLANE_URL ?? env.CLANKIE_CAPTAIN_URL ?? "http://127.0.0.1:4310",
        captainToken: credential.token,
        fetchImpl: (input, init) =>
          (options.fetchImpl ?? fetch)(input, { ...init, signal: AbortSignal.timeout(5_000) }),
      }),
    );
    const seats = await client.roster();
    const fleet =
      options.connectionId && options.connectionId !== "default" ? options.connectionId : undefined;
    parsed.result.agents = parsed.result.agents.map((row) => {
      if (!row || typeof row !== "object") return row;
      const fields = row as Record<string, unknown>;
      const agent = native.find(
        (entry) => entry.terminalId === fields.terminal_id && entry.paneId === fields.pane_id,
      );
      if (!agent?.terminalId || !agent.session) return row;
      const seatId = fleet ? `${fleet}/${agent.terminalId}` : agent.terminalId;
      const seat = seats.find(
        (entry) =>
          entry.seatId === seatId &&
          entry.fleet === fleet &&
          entry.occupantId === occupantIdForHerdrSession(agent.session!),
      );
      if (!seat) return row;
      // Each worker's lead conversation (VUH-1763); `mine` separates this
      // caller's own workers from another lead's when its conversation is known.
      const owner = seat.owner?.conversationId ?? "unowned";
      return {
        ...fields,
        owner,
        ...(seat.owner === undefined ? {} : { hired: seat.owner.hired }),
        ...(env.CLANKIE_CONVERSATION_ID ? { mine: owner === env.CLANKIE_CONVERSATION_ID } : {}),
        ...(seat.waitingMessages ? { waitingMessages: seat.waitingMessages } : {}),
        ...(seat.workerReportBridge ? { workerReportBridge: seat.workerReportBridge } : {}),
        ...(seat.efficiency?.flags.includes("finished, unreported")
          ? { reportFlags: ["finished, unreported"] }
          : {}),
      };
    });
    return `${JSON.stringify(parsed)}\n`;
  } catch {
    // Native roster remains usable when observations are unavailable.
    return stdout;
  }
}

export async function openHerdr(options: HerdrConnectionOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("The Herdr viewer requires a TTY");
  const { command, env } = herdrConnection(await readHerdrBinding(options), options);
  // Explicitly opening a viewer may nest it in another terminal UI; no caller pane identity applies.
  for (const name of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"]) delete env[name];
  const interrupted = () => {}; // The foreground viewer receives the terminal's SIGINT too.
  process.on("SIGINT", interrupted);
  try {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(command, ["client"], { env, stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    process.off("SIGINT", interrupted);
  }
}

/** Pin the endpoint that supplied this pane, including when an ID/session is reused. */
interface AgentHerdrTerminal extends OperatorTerminalSession {
  readonly connection:
    | { readonly kind: "local"; readonly binding: HerdrBinding }
    | { readonly kind: "ssh"; readonly ssh: HerdrSshTransport };
}

/** Owner-triggered native viewer. Resolve the selected runtime, never fall back to default. */
export async function openAgentHerdr(
  terminal: AgentHerdrTerminal,
  options: HerdrConnectionOptions,
  run: (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv,
    interactive: boolean,
  ) => Promise<void> = runAgentViewerCommand,
): Promise<void> {
  const connectionId = terminal.runtime?.id;
  const target = { ...options, ...(connectionId ? { connectionId } : {}) };
  if (connectionId && connectionId !== "default") {
    const inventory = await runRuntimeCommand(["list"], options);
    const connections = inventory.connections as Array<{
      id: string;
      enabled: boolean;
      session?: string;
      ssh?: unknown;
    }>;
    const remote = connections.find((entry) => entry.id === connectionId && entry.enabled);
    if (!remote) throw new Error("That agent's connection is no longer enabled");
    if (remote.ssh !== undefined) {
      if (!remote.session || remote.session !== terminal.runtime?.session)
        throw new Error("That agent's Herdr session changed; reopen it from the strip");
      const ssh = HerdrSshTransportSchema.parse(remote.ssh);
      if (
        terminal.connection.kind !== "ssh" ||
        terminal.connection.ssh.host !== ssh.host ||
        terminal.connection.ssh.shell !== ssh.shell
      )
        throw new Error("That agent's connection changed; reopen it from the strip");
      const env = options.env ?? process.env;
      const prefix = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"];
      await run(
        "ssh",
        [
          ...prefix,
          "--",
          ssh.host,
          remoteProgramCommand(ssh.shell, "herdr", [
            "--session",
            remote.session,
            "agent",
            "focus",
            terminal.pane.id,
          ]),
        ],
        env,
        false,
      );
      // A native TTY is essential on Windows too: don't redirect the viewer through the JSON command runner.
      const viewer =
        ssh.shell === "posix"
          ? remoteProgramCommand(ssh.shell, "herdr", ["--session", remote.session, "client"])
          : powershellScriptCommand(
              `& herdr '--session' ${powershellLiteral(remote.session)} 'client'; exit $LASTEXITCODE`,
            );
      await run("ssh", [...prefix, "-tt", "--", ssh.host, viewer], env, true);
      return;
    }
  }
  if (terminal.connection.kind !== "local")
    throw new Error("That agent's connection changed; reopen it from the strip");
  const binding = await readHerdrBinding(target);
  const pinned = terminal.connection.binding;
  if (
    binding.socketPath !== pinned.socketPath ||
    binding.runtime !== pinned.runtime ||
    binding.session !== pinned.session
  )
    throw new Error("That agent's connection changed; reopen it from the strip");
  if (terminal.runtime && terminal.runtime.session !== binding.session)
    throw new Error("That agent's Herdr session changed; reopen it from the strip");
  const { command, env } = herdrConnection(binding, target);
  await run(command, ["agent", "focus", terminal.pane.id], env, false);
  // Already in the exact workspace: focus its pane instead of nesting another viewer.
  if (env.HERDR_ENV === "1") return;
  for (const name of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"]) delete env[name];
  await run(command, ["client"], env, true);
}

async function runAgentViewerCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  interactive: boolean,
): Promise<void> {
  if (!interactive) {
    await promisify(execFile)(command, [...args], { env, timeout: 10_000, maxBuffer: 1024 * 1024 });
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("The Herdr viewer requires a TTY");
  const interrupted = () => {};
  process.on("SIGINT", interrupted);
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, [...args], { env, stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`Herdr viewer exited (${code ?? "signal"})`)),
      );
    });
  } finally {
    process.off("SIGINT", interrupted);
  }
}

/** Remote terminal observation has no local socket; read the selected fleet's native catalog. */
export async function readAgentHerdrTerminal(
  seat: OperatorFleetSeat,
  options: HerdrConnectionOptions,
): Promise<AgentHerdrTerminal> {
  const qualified = splitFleetQualified(seat.seatId);
  const connectionId = qualified?.fleet ?? seat.fleet ?? "default";
  if (qualified && seat.fleet && qualified.fleet !== seat.fleet)
    throw new Error("Agent fleet identity is inconsistent");
  const target = { ...options, connectionId };
  let catalog: OperatorTerminalSession[];
  let session: string;
  let pinned: AgentHerdrTerminal["connection"];
  if (connectionId !== "default") {
    const inventory = await runRuntimeCommand(["list"], options);
    const connections = inventory.connections as Array<{
      id: string;
      enabled: boolean;
      session?: string;
      ssh?: unknown;
    }>;
    const connection = connections.find((entry) => entry.id === connectionId && entry.enabled);
    if (!connection) throw new Error("That agent's connection is no longer enabled");
    if (connection.ssh !== undefined) {
      if (!connection.session || (seat.herdrSession && connection.session !== seat.herdrSession))
        throw new Error("That agent's Herdr session changed");
      const ssh = HerdrSshTransportSchema.parse(connection.ssh);
      pinned = { kind: "ssh", ssh };
      const run = createHerdrFleetRun(
        { id: connectionId, session: connection.session, ssh },
        { controlDirectory: join(options.env?.HOME ?? homedir(), ".clankie", "ssh") },
      );
      catalog = await readTerminalCatalog({
        runCommand: async (_command, args) => ({ stdout: await run(args), stderr: "" }),
      });
      session = connection.session;
    } else {
      const binding = await readHerdrBinding(target);
      const { command, env } = herdrConnection(binding, target);
      catalog = await readTerminalCatalog({
        runCommand: async (_command, args) =>
          promisify(execFile)(command, [...args], { env, timeout: 5_000 }),
      });
      session = binding.session;
      pinned = { kind: "local", binding };
    }
  } else {
    const binding = await readHerdrBinding(target);
    const { command, env } = herdrConnection(binding, target);
    catalog = await readTerminalCatalog({
      runCommand: async (_command, args) => promisify(execFile)(command, [...args], { env, timeout: 5_000 }),
    });
    session = binding.session;
    pinned = { kind: "local", binding };
  }
  const terminal = catalog.find((item) => item.terminalId === (qualified?.id ?? seat.seatId));
  if (!terminal) throw new Error("That agent's terminal is no longer available");
  return { ...terminal, terminalId: seat.seatId, runtime: { id: connectionId, session }, connection: pinned };
}
