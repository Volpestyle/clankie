import { basename } from "node:path";
import type { WorkConvention } from "@clankie/protocol/work-items";
import type { CommandRunner } from "./convention.ts";
import { readProjectWork } from "./project-read.ts";

/** One work item a release shipped, and the landed commits that name it. */
export interface ReleaseItemSnapshot {
  readonly key: string;
  readonly commits: readonly string[];
}

/** A shipped version as git records it; membership comes from commits, never from a person. */
export interface ReleaseSnapshot {
  readonly version: string;
  readonly tag: string;
  readonly commit: string;
  readonly date: string;
  readonly dateKind: "tag" | "commit" | "published";
  readonly items: readonly ReleaseItemSnapshot[];
}

/** Every version one repository lane has shipped, oldest first. */
export interface ReleaseHistory {
  /** The repository's origin remote (host/path), or its directory name when it has none. */
  readonly repository: string;
  readonly lane: string;
  readonly releases: readonly ReleaseSnapshot[];
}

/** Version order, so each range starts at the previous release rather than the previous tag date. */
export function compareVersions(left: string, right: string): number {
  const parts = (value: string) => value.replace(/^v/u, "").split(/[.+-]/u);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = a[index];
    const y = b[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numeric = /^\d+$/u.test(x) && /^\d+$/u.test(y);
    const order = numeric ? Number(x) - Number(y) : x.localeCompare(y);
    if (order !== 0) return order;
  }
  return 0;
}

/** host/path without scheme, credentials or .git, so clones and worktrees name one repository. */
export function repositoryName(remote: string, root: string): string {
  const trimmed = remote.trim();
  if (trimmed === "") return basename(root);
  const scp = /^[^@/:]+@([^:/]+):(.+)$/u.exec(trimmed);
  const name = scp
    ? `${scp[1]}/${scp[2]}`
    : trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, "").replace(/^[^@/]*@/u, "");
  return name.replace(/\.git$/u, "").replace(/\/+$/u, "");
}

/**
 * Item keys in a commit message: the built-in tracker's own (LOCAL-…) and the
 * connected tracker team the repository's convention names. Anything else that
 * looks like a key (UTF-8, SHA-256) is not work.
 */
export function releaseKeyPattern(convention: WorkConvention): RegExp {
  const team =
    convention.backend === "linear" || convention.backend === "builtin" ? convention.linear?.team : undefined;
  const prefixes = [
    "LOCAL(?:-[A-Z0-9]+)*",
    ...(team ? [team.replace(/[^A-Za-z0-9]/gu, "").toUpperCase()] : []),
  ];
  return new RegExp(`(?<![A-Za-z0-9-])(?:${prefixes.join("|")})-\\d+(?![A-Za-z0-9])`, "gu");
}

/**
 * The repository's shipped versions (the same tag source as `clankie work project`),
 * each with the items named by the commits between the previous version and it.
 */
export async function readReleaseHistory(
  root: string,
  convention: WorkConvention,
  run: CommandRunner,
): Promise<ReleaseHistory> {
  const lane = convention.releases?.lane ?? "repository";
  const facts = await readProjectWork(root, { ...convention, releases: { source: "tags", lane } }, { run });
  if (facts.unavailable.some((entry) => entry.read === "shipped"))
    throw new Error("Version tags could not be read in this repository");
  const remote = await run("git", ["remote", "get-url", "origin"], root).catch(() => "");
  const pattern = releaseKeyPattern(convention);
  const versions = [...facts.shipped].sort((a, b) => compareVersions(a.version, b.version));
  const releases: ReleaseSnapshot[] = [];
  let previous: string | undefined;
  for (const shipped of versions) {
    const tag = shipped.version;
    const commit = (await run("git", ["rev-list", "-n", "1", `refs/tags/${tag}`], root)).trim();
    const log = await run(
      "git",
      ["log", "--format=%H%x1f%B%x1e", previous === undefined ? commit : `${previous}..${commit}`],
      root,
    );
    const items = new Map<string, string[]>();
    for (const entry of log.split("\x1e")) {
      const [hash, message = ""] = entry.trim().split("\x1f");
      if (!hash) continue;
      for (const key of new Set(message.match(pattern) ?? []))
        items.set(key, [...(items.get(key) ?? []), hash]);
    }
    releases.push({
      version: tag,
      tag,
      commit,
      date: shipped.date,
      dateKind: shipped.dateKind,
      items: [...items].map(([key, commits]) => ({ key, commits })),
    });
    previous = commit;
  }
  return { repository: repositoryName(remote, root), lane, releases };
}
