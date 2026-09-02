import { execFile as execFileCallback } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { type ExecFileImpl } from "../install-doctor.ts";

// `clankie autostart`: a user LaunchAgent that runs this install's launcher at
// login. launchd only launches it once (RunAtLoad, no KeepAlive); the launcher's
// own supervision (ADR 0055) owns the processes from there.

export const AUTOSTART_LABEL = "bot.clankie.autostart";
const AUTOSTART_USAGE = "Usage: clankie autostart enable|disable|status";
/** The launcher's dependency-ordered start: the service plus everything that restarts with it. */
const AUTOSTART_SERVICE_ARGS = ["restart", "clankie"] as const;
/** launchd starts jobs with a bare environment; carry the shell's view of these when set. */
const CARRIED_ENVIRONMENT = ["PATH", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const;
const LAUNCHCTL_TIMEOUT_MS = 10_000;

const execFileAsync = promisify(execFileCallback);

export interface AutostartCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Test seam for `launchctl`. */
  readonly execFileImpl?: ExecFileImpl;
  /** Test seam: the executable (and leading arguments) launchd runs; defaults to this install's launcher. */
  readonly launcherCommand?: readonly string[];
  /** Test seam for the launchd `gui/<uid>` domain. */
  readonly uid?: number;
}

export interface AutostartCommandResult {
  readonly ok: true;
  /** `stale` means the agent file and launchd disagree; `enable` repairs it. */
  readonly status: "enabled" | "disabled" | "stale";
  readonly label: string;
  readonly plist: string;
  readonly loaded: boolean;
  readonly command: readonly string[];
  readonly log: string;
}

interface AutostartContext {
  readonly env: NodeJS.ProcessEnv;
  readonly exec: ExecFileImpl;
  readonly domain: string;
  readonly plist: string;
  readonly log: string;
  readonly command: readonly string[];
}

export async function runAutostartCommand(
  args: readonly string[],
  options: AutostartCommandOptions = {},
): Promise<AutostartCommandResult> {
  const verb = args[0] ?? "status";
  if (args.length > 1 || (verb !== "enable" && verb !== "disable" && verb !== "status")) {
    throw new Error(AUTOSTART_USAGE);
  }
  const context = await autostartContext(options);
  if (verb === "enable") return await enable(context);
  if (verb === "disable") return await disable(context);
  return await status(context);
}

async function enable(context: AutostartContext): Promise<AutostartCommandResult> {
  const launcher = context.command[0];
  if (launcher === undefined) throw new Error("Cannot locate the clankie launcher for autostart.");
  try {
    await access(launcher, fsConstants.X_OK);
  } catch {
    throw new Error(`Autostart launcher is not executable: ${launcher}`);
  }
  if (await isLoaded(context)) await bootout(context);
  await mkdir(dirname(context.plist), { recursive: true });
  await mkdir(dirname(context.log), { recursive: true });
  await writeAtomically(context.plist, renderPlist(context));
  await context.exec("launchctl", ["bootstrap", context.domain, context.plist]);
  return result(context, "enabled", true);
}

async function disable(context: AutostartContext): Promise<AutostartCommandResult> {
  if (await isLoaded(context)) await bootout(context);
  await rm(context.plist, { force: true });
  return result(context, "disabled", false);
}

async function status(context: AutostartContext): Promise<AutostartCommandResult> {
  const loaded = await isLoaded(context);
  const present = await exists(context.plist);
  const state = loaded && present ? "enabled" : loaded || present ? "stale" : "disabled";
  return result(context, state, loaded);
}

function result(
  context: AutostartContext,
  state: AutostartCommandResult["status"],
  loaded: boolean,
): AutostartCommandResult {
  return {
    ok: true,
    status: state,
    label: AUTOSTART_LABEL,
    plist: context.plist,
    loaded,
    command: [...context.command, ...AUTOSTART_SERVICE_ARGS],
    log: context.log,
  };
}

async function autostartContext(options: AutostartCommandOptions): Promise<AutostartContext> {
  const env = options.env ?? process.env;
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined)
    throw new Error("clankie autostart needs a login user id for the launchd gui domain.");
  const home = env.HOME?.trim() || homedir();
  const stateHome = env.XDG_STATE_HOME?.trim() || join(home, ".local", "state");
  return {
    env,
    exec: options.execFileImpl ?? defaultExecFile,
    domain: `gui/${String(uid)}`,
    plist: join(home, "Library", "LaunchAgents", `${AUTOSTART_LABEL}.plist`),
    log: join(stateHome, "clankie", "autostart.log"),
    command: await resolveLauncherCommand(env, options),
  };
}

/**
 * The executable launchd runs. A release launcher announces itself through
 * `CLANKIE_LAUNCHER_PATH`; a checkout runs its entrypoint under this Node, since
 * launchd's PATH has no `node`.
 */
async function resolveLauncherCommand(
  env: NodeJS.ProcessEnv,
  options: AutostartCommandOptions,
): Promise<readonly string[]> {
  if (options.launcherCommand !== undefined) return options.launcherCommand;
  const installed = env.CLANKIE_LAUNCHER_PATH?.trim();
  if (installed !== undefined && installed.length > 0) {
    return [await stableLauncherPath(installed, env.CLANKIE_INSTALL_ROOT?.trim())];
  }
  const entrypoint = process.argv[1];
  if (entrypoint === undefined || entrypoint.length === 0) {
    throw new Error("Cannot locate the clankie launcher for autostart.");
  }
  return [process.execPath, resolve(entrypoint)];
}

/** Prefer the install's `current` link so the agent follows upgrades instead of pinning one release. */
async function stableLauncherPath(launcher: string, installRoot: string | undefined): Promise<string> {
  if (installRoot === undefined || installRoot.length === 0) return launcher;
  const candidate = join(dirname(dirname(installRoot)), "current", "bin", "clankie");
  try {
    if ((await realpath(candidate)) === (await realpath(launcher))) return candidate;
  } catch {
    // No `current` link (or it points elsewhere): pin the launcher that is running now.
  }
  return launcher;
}

async function isLoaded(context: AutostartContext): Promise<boolean> {
  try {
    await context.exec("launchctl", ["print", `${context.domain}/${AUTOSTART_LABEL}`]);
    return true;
  } catch {
    return false;
  }
}

async function bootout(context: AutostartContext): Promise<void> {
  await context.exec("launchctl", ["bootout", `${context.domain}/${AUTOSTART_LABEL}`]);
}

function renderPlist(context: AutostartContext): string {
  const carried = CARRIED_ENVIRONMENT.flatMap((name) => {
    const value = context.env[name];
    return value === undefined || value.length === 0 ? [] : [[name, value] as const];
  });
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    `  <key>Label</key><string>${AUTOSTART_LABEL}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...[...context.command, ...AUTOSTART_SERVICE_ARGS].map((argument) => `    ${plistString(argument)}`),
    "  </array>",
    "  <key>RunAtLoad</key><true/>",
    "  <key>KeepAlive</key><false/>",
    `  <key>WorkingDirectory</key>${plistString(dirname(dirname(dirname(context.plist))))}`,
    `  <key>StandardOutPath</key>${plistString(context.log)}`,
    `  <key>StandardErrorPath</key>${plistString(context.log)}`,
  ];
  if (carried.length > 0) {
    lines.push("  <key>EnvironmentVariables</key>", "  <dict>");
    for (const [name, value] of carried) lines.push(`    <key>${name}</key>${plistString(value)}`);
    lines.push("  </dict>");
  }
  lines.push("</dict>", "</plist>", "");
  return lines.join("\n");
}

function plistString(value: string): string {
  return `<string>${value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</string>`;
}

/** Publish the complete file or nothing: launchd must never read a half-written agent. */
async function writeAtomically(path: string, text: string): Promise<void> {
  const temporary = `${path}.${String(process.pid)}.tmp`;
  try {
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o644 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const defaultExecFile: ExecFileImpl = async (command, args) => {
  const output = await execFileAsync(command, [...args], { encoding: "utf8", timeout: LAUNCHCTL_TIMEOUT_MS });
  return { stdout: output.stdout, stderr: output.stderr };
};
