import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type HerdrSessionRunner = (
  command: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr: string }>;

const HERDR_SESSION_LIST_TIMEOUT_MS = 5_000;

/**
 * Env the service must not inherit from wherever it was launched: a service
 * started from inside a herdr pane would otherwise hand its captain a pane
 * identity that is not him and a socket nobody chose (ADR 0149). The seat
 * rides the operator prompt; the session rides `HERDR_SOCKET_PATH`, set below.
 */
const HERDR_CALLER_ENV = [
  "HERDR_ENV",
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
  "HERDR_SOCKET_PATH",
] as const;

export type HerdrSessionPin =
  | { readonly outcome: "pinned"; readonly session: string; readonly socketPath: string }
  | { readonly outcome: "cli_missing" }
  | { readonly outcome: "unknown_session"; readonly session: string };

export function parseHerdrSessionSocket(stdout: string, session: string): string | undefined {
  const parsed = JSON.parse(stdout) as { sessions?: unknown };
  const rows = Array.isArray(parsed.sessions) ? parsed.sessions : [];
  for (const value of rows) {
    if (value === null || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    if (entry.name === session && typeof entry.socket_path === "string" && entry.socket_path.length > 0) {
      return entry.socket_path;
    }
  }
  return undefined;
}

function defaultRunner(
  command: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, [...args], {
    timeout: HERDR_SESSION_LIST_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  }).then(({ stdout, stderr }) => ({ stdout: String(stdout), stderr: String(stderr) }));
}

/**
 * Bind every herdr child this process spawns to the configured session by
 * pinning `HERDR_SOCKET_PATH` to that session's socket, scrubbing whatever
 * herdr identity the process inherited first. Fail-soft: with no herdr CLI
 * the env is left scrubbed, and an unknown session name falls back to
 * herdr's own default-session resolution rather than pointing at a guess.
 */
export async function pinHerdrSessionEnvironment(
  session: string,
  env: NodeJS.ProcessEnv = process.env,
  runCommand: HerdrSessionRunner = defaultRunner,
): Promise<HerdrSessionPin> {
  for (const name of HERDR_CALLER_ENV) delete env[name];
  let stdout: string;
  try {
    ({ stdout } = await runCommand("herdr", ["session", "list", "--json"]));
  } catch {
    return { outcome: "cli_missing" };
  }
  let socketPath: string | undefined;
  try {
    socketPath = parseHerdrSessionSocket(stdout, session);
  } catch {
    return { outcome: "cli_missing" };
  }
  if (socketPath === undefined) return { outcome: "unknown_session", session };
  env.HERDR_SOCKET_PATH = socketPath;
  return { outcome: "pinned", session, socketPath };
}
