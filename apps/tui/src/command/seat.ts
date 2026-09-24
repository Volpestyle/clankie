/**
 * `clankie seat` — land in Claude Code as Clankie
 * ([ADR 0152](../../../../docs/adr/0152-a-harness-takes-the-operator-seat.md)).
 *
 * The plugin carries everything a plugin can declare: the output style, the
 * hooks, the `clankie mcp` server, the skills. Two things it cannot, so this
 * launcher does them: the permission allowlist for `clankie` commands, and the
 * channel development flag the research preview needs. It also names the herdr
 * pane `clankie` when it is one, which is what makes that pane his head.
 */
import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { readHerdrBinding } from "../session/herdr-connection.ts";
import { clankieStateHome } from "../state-home.ts";
import { resolveOperatorCredential, type CredentialStore } from "@clankie/credential-broker";
import { commandHost, outputJson, type Writable } from "./io.ts";

const execFileAsync = promisify(execFileCallback);
const SEAT_USAGE = "Usage: clankie seat [--resume] [--conversation ID] [--plugin-dir PATH] [--dry-run]";
/** The plugin's id once installed from the repo's own marketplace. */
export const SEAT_PLUGIN_ID = "clankie@clankie";
/** The herdr agent name that binds a pane to his persona rather than a fleet contact. */
const SEAT_AGENT_NAME = "clankie";
const SEAT_PERMISSIONS = { permissions: { allow: ["Bash(clankie)", "Bash(clankie *)"] } };
/**
 * The plugin's output style is forced on wherever the plugin is enabled, so an
 * installed plugin stays disabled at user scope — otherwise every Claude Code
 * session on the machine would answer as him — and the seat enables it for
 * its own session only.
 */
const SEAT_SETTINGS = { ...SEAT_PERMISSIONS, enabledPlugins: { [SEAT_PLUGIN_ID]: true } };
const HERDR_DETECT_TIMEOUT_MS = 30_000;
const HERDR_DETECT_POLL_MS = 500;

export interface SeatPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly plugin:
    | { readonly source: "installed" }
    | { readonly source: "plugin-dir"; readonly path: string };
  /** Whether wakes and escalations can reach this session as channel events. */
  readonly channel: boolean;
  readonly sessionId: string;
  readonly resumed: boolean;
  readonly conversationId?: string;
  readonly cwd: string;
  readonly herdrPaneId?: string;
}

interface SeatRecord {
  readonly conversationId?: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly startedAt: string;
}

export interface SeatCommandOptions {
  readonly repoRoot: string;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
  readonly env?: NodeJS.ProcessEnv;
  readonly execFileImpl?: (
    command: string,
    args: readonly string[],
  ) => Promise<{ readonly stdout: string; readonly stderr: string }>;
  readonly spawnImpl?: (
    command: string,
    args: readonly string[],
    cwd: string,
    env?: NodeJS.ProcessEnv,
  ) => Promise<number>;
  readonly sleepImpl?: (ms: number) => Promise<void>;
  /** Test seam: the socket of the session the service leads; undefined when it cannot be read. */
  readonly fleetSocketPath?: () => Promise<string | undefined>;
  readonly stdout?: Writable;
  readonly stderr?: Writable;
}

interface SeatFlags {
  readonly conversationId?: string;
  readonly resume: boolean;
  readonly dryRun: boolean;
  readonly pluginDir?: string;
}

export function parseSeatArgs(args: readonly string[]): SeatFlags {
  let conversationId: string | undefined;
  let resume = false;
  let dryRun = false;
  let pluginDir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--resume") resume = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--conversation") {
      const value = args[++index]?.trim();
      if (!value || value.startsWith("--")) throw new Error(SEAT_USAGE);
      conversationId = value;
    } else if (arg === "--plugin-dir") {
      const value = args[index + 1];
      if (value === undefined || value.length === 0) throw new Error(SEAT_USAGE);
      pluginDir = value;
      index += 1;
    } else throw new Error(SEAT_USAGE);
  }
  return {
    resume,
    dryRun,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(pluginDir === undefined ? {} : { pluginDir }),
  };
}

function seatRecordPath(env: NodeJS.ProcessEnv): string {
  return join(clankieStateHome(env), "clankie", "seat.json");
}

function readSeatRecord(env: NodeJS.ProcessEnv): SeatRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(seatRecordPath(env), "utf8")) as Partial<SeatRecord>;
    return typeof parsed.sessionId === "string" && typeof parsed.cwd === "string"
      ? {
          sessionId: parsed.sessionId,
          cwd: parsed.cwd,
          startedAt: parsed.startedAt ?? "",
          ...(typeof parsed.conversationId === "string" ? { conversationId: parsed.conversationId } : {}),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function writeSeatRecord(env: NodeJS.ProcessEnv, record: SeatRecord): void {
  const path = seatRecordPath(env);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

async function defaultExecFile(
  command: string,
  args: readonly string[],
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await execFileAsync(command, [...args], { timeout: 15_000, encoding: "utf8" });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: "inherit", ...(env === undefined ? {} : { env }) });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
  });
}

/** Whether the plugin is installed at any scope, enabled or not, per `claude plugin list --json`. */
export function pluginInstalled(listJson: string): boolean {
  try {
    const parsed: unknown = JSON.parse(listJson);
    return (
      Array.isArray(parsed) &&
      parsed.some(
        (entry) =>
          typeof entry === "object" && entry !== null && (entry as { id?: unknown }).id === SEAT_PLUGIN_ID,
      )
    );
  } catch {
    return false;
  }
}

/** Herdr's own reason for refusing a name, or the raw failure. */
function herdrFailureText(caught: unknown): string {
  const failure = caught as { readonly stderr?: unknown; readonly message?: unknown };
  const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
  const envelope = /\{"error":.*\}/u.exec(stderr);
  if (envelope !== null) {
    try {
      const message = (JSON.parse(envelope[0]) as { error?: { message?: unknown } }).error?.message;
      if (typeof message === "string" && message.length > 0) return message;
    } catch {
      // Not an envelope after all.
    }
  }
  return caught instanceof Error ? caught.message : String(caught);
}

export async function planSeat(flags: SeatFlags, options: SeatCommandOptions): Promise<SeatPlan> {
  const env = options.env ?? process.env;
  const execFile = options.execFileImpl ?? defaultExecFile;
  try {
    await execFile("claude", ["--version"]);
  } catch {
    throw new Error("Claude Code is not on PATH; install it first (https://code.claude.com).");
  }

  let plugin: SeatPlan["plugin"];
  if (flags.pluginDir !== undefined) {
    plugin = { source: "plugin-dir", path: flags.pluginDir };
  } else {
    let listed = "";
    try {
      listed = (await execFile("claude", ["plugin", "list", "--json"])).stdout;
    } catch {
      // No plugin registry yet reads the same as "not installed".
    }
    if (pluginInstalled(listed)) {
      plugin = { source: "installed" };
    } else {
      const bundled = join(options.repoRoot, "integrations", "claude-plugin");
      if (!existsSync(join(bundled, ".claude-plugin", "plugin.json"))) {
        throw new Error(
          `The Clankie plugin is neither installed (${SEAT_PLUGIN_ID}) nor bundled at ${bundled}; run \`claude plugin marketplace add ${bundled}\` then \`claude plugin install ${SEAT_PLUGIN_ID}\`.`,
        );
      }
      plugin = { source: "plugin-dir", path: bundled };
    }
  }

  const previous = flags.resume ? readSeatRecord(env) : undefined;
  if (flags.resume && previous === undefined) {
    throw new Error("No seat to resume; `clankie seat` first.");
  }
  const sessionId = previous?.sessionId ?? randomUUID();
  if (
    previous !== undefined &&
    flags.conversationId !== undefined &&
    flags.conversationId !== previous.conversationId
  )
    throw new Error("A resumed seat keeps its conversation; start a new seat to select another one.");
  const conversationId = previous?.conversationId ?? flags.conversationId;
  let cwd = previous?.cwd ?? process.cwd();
  if (conversationId !== undefined) {
    const credential = await resolveOperatorCredential({
      env,
      ...(options.operatorCredentialStore === undefined ? {} : { store: options.operatorCredentialStore }),
    });
    if (credential === undefined)
      throw new Error("No operator credential is available; start Clankie first.");
    const url = new URL("/v1/captain/seat-context", commandHost({ ...options, env }));
    url.searchParams.set("conversationId", conversationId);
    const response = await (options.fetchImpl ?? fetch)(url, {
      headers: { authorization: `Bearer ${credential.token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`Seat conversation unavailable (${response.status})`);
    const binding = (await response.json()) as { conversationId?: unknown; cwd?: unknown };
    if (binding.conversationId !== conversationId || typeof binding.cwd !== "string" || !binding.cwd)
      throw new Error("Invalid service seat context");
    cwd = binding.cwd;
  }
  // Channels are a research preview: the development flag is per plugin entry
  // and only a marketplace-installed plugin has one, so a checkout loaded with
  // --plugin-dir gets his tools and skills but not his wakes.
  const channel = plugin.source === "installed";
  const args = [
    "--name",
    "Clankie",
    "--settings",
    JSON.stringify(plugin.source === "installed" ? SEAT_SETTINGS : SEAT_PERMISSIONS),
    ...(plugin.source === "plugin-dir" ? ["--plugin-dir", plugin.path] : []),
    ...(channel ? ["--dangerously-load-development-channels", `plugin:${SEAT_PLUGIN_ID}`] : []),
    ...(previous === undefined ? ["--session-id", sessionId] : ["--resume", sessionId]),
  ];
  // This pane is his head only inside the fleet the service leads (ADR 0164):
  // a seat opened in any other Herdr session names no pane there.
  const paneId =
    conversationId === undefined && env.HERDR_ENV === "1" ? env.HERDR_PANE_ID?.trim() : undefined;
  const fleetSocket =
    paneId === undefined || paneId.length === 0
      ? undefined
      : await (
          options.fleetSocketPath ??
          (() => readHerdrBinding({ repoRoot: options.repoRoot, env }).then((binding) => binding.socketPath))
        )().catch(() => undefined);
  const herdrPaneId = fleetSocket !== undefined && env.HERDR_SOCKET_PATH === fleetSocket ? paneId : undefined;
  return {
    command: "claude",
    args,
    plugin,
    channel,
    sessionId,
    resumed: previous !== undefined,
    ...(conversationId === undefined ? {} : { conversationId }),
    cwd,
    ...(herdrPaneId === undefined || herdrPaneId.length === 0 ? {} : { herdrPaneId }),
  };
}

/**
 * Name the pane once herdr has seen Claude Code start in it. Herdr keeps agent
 * names unique among live agents, so a second seat is refused by name: that
 * pane stays an ordinary fleet agent and the operator is told so.
 */
async function claimHerdrSeat(
  paneId: string,
  execFile: NonNullable<SeatCommandOptions["execFileImpl"]>,
  sleep: (ms: number) => Promise<void>,
  stderr: Writable,
): Promise<void> {
  const deadline = Date.now() + HERDR_DETECT_TIMEOUT_MS;
  for (;;) {
    try {
      const { stdout } = await execFile("herdr", ["agent", "get", paneId]);
      const agent = (JSON.parse(stdout) as { result?: { agent?: { agent?: unknown } } }).result?.agent?.agent;
      if (agent === "claude") break;
    } catch {
      // Not detected yet, or herdr is not answering; keep waiting until the deadline.
    }
    if (Date.now() >= deadline) {
      stderr.write("clankie seat: herdr never saw Claude Code in this pane; the seat is unnamed.\n");
      return;
    }
    await sleep(HERDR_DETECT_POLL_MS);
  }
  try {
    await execFile("herdr", ["agent", "rename", paneId, SEAT_AGENT_NAME]);
    stderr.write(`clankie seat: pane ${paneId} is now ${SEAT_AGENT_NAME}; this seat is his head.\n`);
  } catch (caught) {
    stderr.write(
      `clankie seat: another pane already holds the ${SEAT_AGENT_NAME} seat (${herdrFailureText(caught)}); this pane stays an ordinary fleet agent.\n`,
    );
  }
}

export async function runSeatCommand(args: readonly string[], options: SeatCommandOptions): Promise<number> {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const flags = parseSeatArgs(args);
  const plan = await planSeat(flags, options);
  if (flags.dryRun) {
    outputJson(stdout, { ok: true, ...plan });
    return 0;
  }
  if (!plan.resumed) {
    writeSeatRecord(env, {
      sessionId: plan.sessionId,
      cwd: plan.cwd,
      startedAt: new Date().toISOString(),
      ...(plan.conversationId === undefined ? {} : { conversationId: plan.conversationId }),
    });
  }
  const execFile = options.execFileImpl ?? defaultExecFile;
  const sleep = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  // The service owns the lead actor. A portal never inherits a worker's Swarm
  // session from the terminal it happened to launch in.
  const seatEnv = { ...env };
  for (const key of Object.keys(seatEnv)) if (key.startsWith("SWARM_")) delete seatEnv[key];
  delete seatEnv.CLANKIE_CONVERSATION_ID;
  seatEnv.CLANKIE_SEAT_SESSION_ID = plan.sessionId;
  if (plan.conversationId !== undefined) seatEnv.CLANKIE_CONVERSATION_ID = plan.conversationId;
  const running = (options.spawnImpl ?? defaultSpawn)(
    plan.command,
    [...plan.args, "--permission-mode", "auto"],
    plan.cwd,
    seatEnv,
  );
  const claim =
    plan.herdrPaneId === undefined
      ? Promise.resolve()
      : claimHerdrSeat(plan.herdrPaneId, execFile, sleep, stderr).catch(() => undefined);
  const exitCode = await running;
  await claim;
  if (plan.herdrPaneId !== undefined) {
    await execFile("herdr", ["agent", "rename", plan.herdrPaneId, "--clear"]).catch(() => undefined);
  }
  return exitCode;
}
