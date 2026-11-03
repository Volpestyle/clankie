import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const GITHUB_REMOTE =
  /^(?:git@github\.com:|(?:https?|ssh):\/\/(?:[^@/]+@)?github\.com\/)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/u;

/** The git directory that holds `config` for a checkout, following a linked worktree to its main repository. */
function commonGitDirectory(directory: string): string | undefined {
  for (let current = directory; ; current = dirname(current)) {
    const dotGit = join(current, ".git");
    try {
      if (statSync(dotGit).isDirectory()) return dotGit;
      const pointer = /^gitdir:\s*(.+)$/mu.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
      if (pointer === undefined) return undefined;
      const gitDirectory = resolve(current, pointer);
      try {
        return resolve(gitDirectory, readFileSync(join(gitDirectory, "commondir"), "utf8").trim());
      } catch {
        return gitDirectory;
      }
    } catch {
      // No `.git` here; look in the parent.
    }
    if (dirname(current) === current) return undefined;
  }
}

/** `origin`'s URL from a git config, ignoring every other remote. */
function originUrl(config: string): string | undefined {
  let inOrigin = false;
  for (const line of config.split("\n")) {
    const section = /^\s*\[([^\]]+)\]/u.exec(line);
    if (section) {
      inOrigin = /^remote\s+"origin"$/u.test(section[1]!.trim());
      continue;
    }
    const url = inOrigin ? /^\s*url\s*=\s*(.+?)\s*$/u.exec(line)?.[1] : undefined;
    if (url !== undefined) return url;
  }
  return undefined;
}

/**
 * A checkout's GitHub `owner/name` from its `origin`, read from the repository's own config
 * without running git, so it can be asked synchronously. Anything else (another forge, no
 * origin, a path on another machine) is undefined, and each directory is read once.
 */
export function createGithubOriginReader(): (directory: string) => string | undefined {
  const known = new Map<string, string | undefined>();
  return (directory) => {
    if (!isAbsolute(directory)) return undefined;
    if (known.has(directory)) return known.get(directory);
    let repository: string | undefined;
    try {
      const gitDirectory = commonGitDirectory(directory);
      const url =
        gitDirectory === undefined
          ? undefined
          : originUrl(readFileSync(join(gitDirectory, "config"), "utf8"));
      repository = url === undefined ? undefined : GITHUB_REMOTE.exec(url)?.[1];
    } catch {
      repository = undefined;
    }
    known.set(directory, repository);
    return repository;
  };
}
