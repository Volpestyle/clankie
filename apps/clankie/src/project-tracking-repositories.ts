import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { Project } from "@clankie/protocol/projects";
const exec = promisify(execFile);

/** Read-only product sources; adding one never enrolls its path for fleet admission. */
export async function trackingRepositoryPaths(project: Project): Promise<string[]> {
  const paths: string[] = [];
  for (const repo of project.tracking?.repositories ?? []) {
    const path = repo.localPath;
    if (!path) continue;
    try {
      if ((await realpath(path)) !== path) continue;
      const git = async (args: string[]) =>
        (await exec("git", ["-C", path, ...args], { timeout: 5000, maxBuffer: 64 * 1024 })).stdout.trim();
      if ((await git(["rev-parse", "--show-toplevel"])) !== path) continue;
      const origin = await git(["remote", "get-url", "origin"]);
      const name = /^(?:git@github\.com:|https:\/\/github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?$/u.exec(
        origin,
      )?.[1];
      if (name?.toLowerCase() === repo.repository.toLowerCase()) paths.push(path);
    } catch {
      /* Missing or changed sources grant no read to a replacement repository. */
    }
  }
  return paths;
}
