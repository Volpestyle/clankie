import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT_COMMIT = /^[0-9a-f]{40,64}$/u;

export async function stableProjectId(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const configured = env.CLANKIE_CAPTAIN_PROJECT_ID?.trim();
  if (configured !== undefined && configured.length > 0) {
    if (!ROOT_COMMIT.test(configured)) {
      throw new Error("CLANKIE_CAPTAIN_PROJECT_ID must be a Git root-commit hash");
    }
    return configured;
  }

  const { stdout } = await execFileAsync("git", ["rev-list", "--max-parents=0", "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  const roots = stdout
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .sort();
  if (roots.length === 0 || roots.some((value) => !ROOT_COMMIT.test(value))) {
    throw new Error("Cannot derive a stable captain project id from the Git root commit");
  }
  if (roots.length === 1) return roots[0] as string;
  return createHash("sha256").update(roots.join("\n")).digest("hex");
}

export function captainSessionDatabasePath(projectId: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!ROOT_COMMIT.test(projectId)) throw new Error("Invalid captain project id");
  const stateRoot = env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(stateRoot, "clankie", "captain-sessions", `${projectId}.sqlite`);
}

export function captainLaneDatabasePath(projectId: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!ROOT_COMMIT.test(projectId)) throw new Error("Invalid captain project id");
  const stateRoot = env.XDG_STATE_HOME?.trim() || join(homedir(), ".local", "state");
  return join(stateRoot, "clankie", "captain-lanes", `${projectId}.sqlite`);
}
