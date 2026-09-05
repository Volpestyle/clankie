import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import type { HerdrSettings } from "@clankie/settings";

const exec = promisify(execFile);
type HerdrSessionRunner = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ stdout: string }>;

function parseHerdrSessionSocket(stdout: string, session: string): string | undefined {
  const parsed = JSON.parse(stdout) as { sessions?: unknown };
  const rows = Array.isArray(parsed.sessions) ? parsed.sessions : [];
  for (const value of rows) {
    if (value === null || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    if (entry.name === session && typeof entry.socket_path === "string") return entry.socket_path;
  }
  return undefined;
}

/** Resolve once in the service, never in a TUI. Unreachable adoption fails closed. */
export async function resolveHerdrBinding(
  settings: HerdrSettings,
  env: NodeJS.ProcessEnv = process.env,
  run: HerdrSessionRunner = (command, args, childEnv) =>
    exec(command, [...args], { env: childEnv, timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }),
): Promise<HerdrSettings> {
  // Preserve an explicitly named session from settings written before runtime selection existed.
  const adopt = settings.runtime === "auto" && settings.session === "default" && !settings.socketPath;
  const external =
    settings.runtime === "external" || (settings.runtime === "auto" && (!adopt || env.HERDR_ENV === "1"));
  if (!external) return { runtime: "bundled", session: settings.session };
  const session = adopt ? env.HERDR_SESSION?.trim() || "default" : settings.session;
  let socketPath = adopt ? env.HERDR_SOCKET_PATH?.trim() : settings.socketPath;
  if (!socketPath) {
    const { stdout } = await run("herdr", ["session", "list", "--json"], env);
    socketPath = parseHerdrSessionSocket(stdout, session);
  }
  if (!socketPath || !isAbsolute(socketPath) || Buffer.byteLength(socketPath) > 102) {
    throw new Error(`External Herdr session has no usable socket: ${session}`);
  }
  const pinned = { ...env };
  for (const name of Object.keys(pinned)) if (name.startsWith("HERDR_")) delete pinned[name];
  pinned.HERDR_SOCKET_PATH = socketPath;
  // CLI commands never start a server; a dead saved session cannot silently become another fleet.
  const { stdout } = await run("herdr", ["api", "snapshot"], pinned);
  if (!JSON.parse(stdout)?.result?.snapshot) throw new Error(`Herdr is unavailable at ${socketPath}`);
  for (const name of Object.keys(env)) if (name.startsWith("HERDR_")) delete env[name];
  env.HERDR_SOCKET_PATH = socketPath;
  delete env.HERD_LEAD_SUMMARIES_CACHE;
  delete env.HERDR_PLUGIN_STATE_DIR;
  return { runtime: "external", session, socketPath };
}
