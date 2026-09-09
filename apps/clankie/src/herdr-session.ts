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

interface HerdrSessionRow {
  readonly name: string;
  readonly socketPath: string;
}

/** A path Herdr can actually listen on; anything else is not a candidate. */
function usableSocket(value: string | undefined): string | undefined {
  const path = value?.trim();
  return path !== undefined && path !== "" && isAbsolute(path) && Buffer.byteLength(path) <= 102
    ? path
    : undefined;
}

/** A name the settings schema and the binding contract both accept. */
function usableSession(value: string | undefined): string | undefined {
  const name = value?.trim();
  return name !== undefined && /^[\w][\w.-]{0,63}$/u.test(name) ? name : undefined;
}

function parseHerdrSessions(stdout: string): readonly HerdrSessionRow[] {
  const parsed = JSON.parse(stdout) as { sessions?: unknown };
  const rows = Array.isArray(parsed.sessions) ? parsed.sessions : [];
  return rows.flatMap((value) => {
    if (value === null || typeof value !== "object") return [];
    const entry = value as Record<string, unknown>;
    const name = typeof entry.name === "string" ? usableSession(entry.name) : undefined;
    const socketPath = typeof entry.socket_path === "string" ? usableSocket(entry.socket_path) : undefined;
    return name === undefined || socketPath === undefined ? [] : [{ name, socketPath }];
  });
}

/** Saved sessions, or none: a missing CLI is one more candidate that cannot answer. */
async function listSessions(
  run: HerdrSessionRunner,
  env: NodeJS.ProcessEnv,
): Promise<readonly HerdrSessionRow[]> {
  try {
    return parseHerdrSessions((await run("herdr", ["session", "list", "--json"], env)).stdout);
  } catch {
    return [];
  }
}

/** One Herdr for every child Clankie spawns, whatever identity the launch env carried. */
function pin(env: NodeJS.ProcessEnv, socketPath: string): NodeJS.ProcessEnv {
  for (const name of Object.keys(env)) if (name.startsWith("HERDR_")) delete env[name];
  env.HERDR_SOCKET_PATH = socketPath;
  delete env.HERD_LEAD_SUMMARIES_CACHE;
  return env;
}

/**
 * Whether a server answers on this socket. CLI commands never start one, so a
 * saved session that is down reads as down instead of quietly becoming a fleet.
 */
async function answers(
  socketPath: string,
  env: NodeJS.ProcessEnv,
  run: HerdrSessionRunner,
): Promise<boolean> {
  try {
    const { stdout } = await run("herdr", ["api", "snapshot"], pin({ ...env }, socketPath));
    return Boolean((JSON.parse(stdout) as { result?: { snapshot?: unknown } }).result?.snapshot);
  } catch {
    return false;
  }
}

/**
 * Which Herdr the service leads, decided fresh at every start (ADR 0170):
 * the session the owner named, else the session the service was launched
 * inside, else his own bundled fleet. A candidate that does not answer is
 * skipped, never fatal — a session that stopped between two starts costs a
 * fallback rather than the boot.
 */
export async function resolveHerdrBinding(
  settings: HerdrSettings,
  env: NodeJS.ProcessEnv = process.env,
  run: HerdrSessionRunner = (command, args, childEnv) =>
    exec(command, [...args], { env: childEnv, timeout: 5_000, maxBuffer: 8 * 1024 * 1024 }),
): Promise<HerdrSettings> {
  const bundled = { runtime: "bundled", session: settings.session } as const;
  if (settings.runtime === "bundled") return bundled;
  let sessions: readonly HerdrSessionRow[] | undefined;
  const candidates: (HerdrSettings & { socketPath: string })[] = [];
  // The owner's own words first: a named session or socket is a standing
  // instruction, and it outranks whatever terminal the service was started from.
  const named =
    settings.runtime === "external" || settings.session !== "default" || settings.socketPath !== undefined;
  if (named) {
    const socketPath =
      usableSocket(settings.socketPath) ??
      (sessions ??= await listSessions(run, env)).find((row) => row.name === settings.session)?.socketPath;
    if (socketPath !== undefined)
      candidates.push({ runtime: "external", session: settings.session, socketPath });
  }
  // Then the session he was launched in: starting Clankie from a pane is the
  // owner saying "lead this one", and it costs no configuration.
  const surrounding = usableSocket(env.HERDR_SOCKET_PATH);
  if (surrounding !== undefined && !candidates.some((entry) => entry.socketPath === surrounding)) {
    const name =
      (sessions ??= await listSessions(run, env)).find((row) => row.socketPath === surrounding)?.name ??
      usableSession(env.HERDR_SESSION) ??
      "default";
    candidates.push({ runtime: "external", session: name, socketPath: surrounding });
  }
  for (const candidate of candidates) {
    if (!(await answers(candidate.socketPath, env, run))) continue;
    pin(env, candidate.socketPath);
    return candidate;
  }
  return bundled;
}
