import { bundledSkills, projectSkillPlugin, SettingsStore, defaultSettingsPath } from "@clankie/settings";
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
import type { CredentialStore } from "@clankie/credential-broker";
import { outputJson, type Writable } from "./io.ts";
import { resolveSeatContext, type NewSeatConversation } from "./seat-context.ts";
import { claudeTrackerDenyRules } from "../../../clankie/src/captain/tracker-isolation.ts";

const execFileAsync = promisify(execFileCallback);
const SEAT_USAGE =
  "Usage: clankie seat [--harness claude|codex|opencode] [--resume] [--conversation ID] [--plugin-dir PATH] [--dry-run]";
/** The plugin's id once installed from the repo's own marketplace. */
export const SEAT_PLUGIN_ID = "clankie@clankie";
/** The herdr agent name that binds a pane to his persona rather than a fleet contact. */
const SEAT_AGENT_NAME = "clankie";
// Claude Code server-prefix deny rules cover every tool from the inherited connector.
const SEAT_PERMISSIONS = {
  permissions: { allow: ["Bash(clankie)", "Bash(clankie *)"], deny: ["mcp__linear-server"] },
};
/**
 * The plugin's output style is forced on wherever the plugin is enabled, so an
 * installed plugin stays disabled at user scope — otherwise every Claude Code
 * session on the machine would answer as him — and the seat enables it for
 * its own session only. The launch projection supersedes the installed copy.
 */
const SEAT_SETTINGS = {
  ...SEAT_PERMISSIONS,
  enabledPlugins: { [SEAT_PLUGIN_ID]: false, "clankie@inline": true },
};

/** The seat's settings, also denying every other tracker connector this session would inherit. */
function seatSettings(cwd: string, env: NodeJS.ProcessEnv) {
  const deny = [...new Set([...SEAT_PERMISSIONS.permissions.deny, ...claudeTrackerDenyRules(cwd, env)])];
  return { ...SEAT_SETTINGS, permissions: { ...SEAT_PERMISSIONS.permissions, deny } };
}
const HERDR_DETECT_TIMEOUT_MS = 30_000;
const HERDR_DETECT_POLL_MS = 500;

export interface SeatPlan {
  readonly command: string;
  readonly args: readonly string[];
  readonly plugin: { readonly source: "plugin-dir"; readonly path: string };
  readonly skills: ReturnType<typeof bundledSkills>;
  /** Whether wakes and escalations can reach this session as channel events. */
  readonly channel: boolean;
  readonly sessionId: string;
  readonly resumed: boolean;
  readonly conversationId?: string;
  /** A fresh chat to create at launch; --dry-run leaves the registry untouched. */
  readonly newConversation?: NewSeatConversation;
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
  /** Claude command selected by `clankie claude[N]`. */
  readonly claudeCommand?: string;
  readonly host?: string;
  readonly fetchImpl?: typeof fetch;
  readonly operatorCredentialStore?: CredentialStore;
  readonly env?: NodeJS.ProcessEnv;
  /** Codex `-c` overrides that switch off inherited tracker connectors (tests inject these). */
  readonly trackerOverrides?: (cwd: string, env: NodeJS.ProcessEnv) => Promise<string[]>;
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
  readonly harness?: "claude" | "codex" | "opencode";
  readonly conversationId?: string;
  readonly resume: boolean;
  readonly dryRun: boolean;
  readonly pluginDir?: string;
}

export function parseSeatArgs(args: readonly string[]): SeatFlags {
  let harness: SeatFlags["harness"];
  let conversationId: string | undefined;
  let resume = false;
  let dryRun = false;
  let pluginDir: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--harness") {
      const value = args[++index];
      if (value !== "claude" && value !== "codex" && value !== "opencode") throw new Error(SEAT_USAGE);
      harness = value;
    } else if (arg === "--resume") resume = true;
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
    ...(harness === undefined ? {} : { harness }),
    resume,
    dryRun,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(pluginDir === undefined ? {} : { pluginDir }),
  };
}

function seatRecordPath(env: NodeJS.ProcessEnv, command = "claude"): string {
  return join(clankieStateHome(env), "clankie", command === "claude" ? "seat.json" : `seat-${command}.json`);
}

function readSeatRecord(env: NodeJS.ProcessEnv, command: string): SeatRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(seatRecordPath(env, command), "utf8")) as Partial<SeatRecord>;
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

function writeSeatRecord(env: NodeJS.ProcessEnv, record: SeatRecord, command: string): void {
  const path = seatRecordPath(env, command);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

/** Numbered account commands may be aliases or functions in the owner's shell. */
function claudeLaunch(command: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  return /^claude\d+$/u.test(command)
    ? { command: env.SHELL || "/bin/zsh", args: ["-ic", `${command} "$@"`, "clankie-seat", ...args] }
    : { command, args: [...args] };
}

async function defaultExecFile(
  command: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const result = await execFileAsync(command, [...args], { timeout: 15_000, encoding: "utf8", env });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<number> {
  const launch = claudeLaunch(command, args, env ?? process.env);
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, launch.args, {
      cwd,
      stdio: "inherit",
      ...(env === undefined ? {} : { env }),
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal === null ? 1 : 128)));
  });
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
  if (options.claudeCommand !== undefined && flags.harness !== undefined && flags.harness !== "claude")
    throw new Error(SEAT_USAGE);
  if (flags.harness === "opencode") {
    const { planOpenCodeSeat } = await import("./opencode-seat.ts");
    return planOpenCodeSeat(flags, options);
  }
  if (flags.harness === "codex") {
    const { planCodexSeat } = await import("./codex-seat.ts");
    return planCodexSeat(flags, options);
  }
  const env = options.env ?? process.env;
  const command = options.claudeCommand ?? "claude";
  if (!/^claude\d*$/u.test(command)) throw new Error("Invalid Claude command");
  const execFile =
    options.execFileImpl ??
    ((name, args) => {
      const launch = claudeLaunch(name, args, env);
      return defaultExecFile(launch.command, launch.args, env);
    });
  try {
    await execFile(command, ["--version"]);
  } catch {
    throw new Error(
      `${command} is unavailable; install Claude Code or define the command in your shell (https://code.claude.com).`,
    );
  }

  const source = flags.pluginDir ?? join(options.repoRoot, "integrations", "claude-plugin");
  if (!existsSync(join(source, ".claude-plugin", "plugin.json"))) {
    throw new Error(
      `The Clankie plugin is not bundled at ${source}; update this install or pass --plugin-dir PATH.`,
    );
  }
  const selection = (await new SettingsStore(defaultSettingsPath(env)).load()).skills;
  const skills = bundledSkills(options.repoRoot, selection);
  const plugin: SeatPlan["plugin"] = {
    source: "plugin-dir",
    path: await projectSkillPlugin(source, join(clankieStateHome(env), "clankie"), skills),
  };

  const previous = flags.resume ? readSeatRecord(env, command) : undefined;
  if (flags.resume && previous === undefined) {
    throw new Error("No seat to resume; `clankie seat` first.");
  }
  const sessionId = previous?.sessionId ?? randomUUID();
  if (
    previous !== undefined &&
    flags.conversationId !== undefined &&
    flags.conversationId !== (previous.conversationId ?? "global-default")
  )
    throw new Error("A resumed seat keeps its conversation; start a new seat to select another one.");
  const context = await resolveSeatContext(
    {
      conversationId:
        previous === undefined ? flags.conversationId : (previous.conversationId ?? "global-default"),
      cwd: previous?.cwd ?? process.cwd(),
      command,
      dryRun: true,
    },
    options,
  );
  const { conversationId, cwd } = context;
  // Session-only plugins have the native @inline identity. Keep wakes on the
  // same projected plugin, without enabling an older installed skill catalog.
  const channel = true;
  const args = [
    "--name",
    "Clankie",
    "--settings",
    JSON.stringify(seatSettings(cwd, env)),
    "--plugin-dir",
    plugin.path,
    "--dangerously-load-development-channels",
    "plugin:clankie@inline",
    ...(previous === undefined ? ["--session-id", sessionId] : ["--resume", sessionId]),
  ];
  // This pane is his head only inside the fleet the service leads (ADR 0164):
  // a seat opened in any other Herdr session names no pane there.
  const paneId =
    conversationId === "global-default" && env.HERDR_ENV === "1" ? env.HERDR_PANE_ID?.trim() : undefined;
  const fleetSocket =
    paneId === undefined || paneId.length === 0
      ? undefined
      : await (
          options.fleetSocketPath ??
          (() => readHerdrBinding({ repoRoot: options.repoRoot, env }).then((binding) => binding.socketPath))
        )().catch(() => undefined);
  const herdrPaneId = fleetSocket !== undefined && env.HERDR_SOCKET_PATH === fleetSocket ? paneId : undefined;
  return {
    command,
    skills,
    args,
    plugin,
    channel,
    sessionId,
    resumed: previous !== undefined,
    ...(conversationId === undefined ? {} : { conversationId }),
    ...(context.newConversation === undefined ? {} : { newConversation: context.newConversation }),
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
  if (options.claudeCommand !== undefined && flags.harness !== undefined && flags.harness !== "claude")
    throw new Error(SEAT_USAGE);
  if (flags.harness === "opencode") {
    const { runOpenCodeSeat } = await import("./opencode-seat.ts");
    return runOpenCodeSeat(flags, options);
  }
  if (flags.harness === "codex") {
    const { runCodexSeat } = await import("./codex-seat.ts");
    return runCodexSeat(flags, options);
  }
  let plan = await planSeat(flags, options);
  if (flags.dryRun) {
    outputJson(stdout, { ok: true, ...plan });
    return 0;
  }
  if (plan.newConversation !== undefined) {
    plan = {
      ...plan,
      ...(await resolveSeatContext({ cwd: plan.cwd, command: plan.command, dryRun: false }, options)),
    };
  }
  if (!plan.resumed) {
    writeSeatRecord(
      env,
      {
        sessionId: plan.sessionId,
        cwd: plan.cwd,
        startedAt: new Date().toISOString(),
        ...(plan.conversationId === undefined ? {} : { conversationId: plan.conversationId }),
      },
      plan.command,
    );
  }
  const execFile = options.execFileImpl ?? defaultExecFile;
  const sleep = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  // The service owns the lead actor. A portal never inherits a worker's Swarm
  // session from the terminal it happened to launch in.
  const seatEnv = { ...env };
  for (const key of Object.keys(seatEnv)) if (key.startsWith("SWARM_")) delete seatEnv[key];
  delete seatEnv.CLANKIE_CONVERSATION_ID;
  delete seatEnv.CLANKIE_CODEX_SEAT_BINDING;
  seatEnv.CLANKIE_SEAT_HARNESS = "claude";
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
