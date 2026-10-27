import { execFile } from "node:child_process";
import { posix } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Where a changed line counts (ADR 0270). */
type ChurnBucket = "product" | "tooling" | "docs" | "excluded";
type ChurnLines = Record<ChurnBucket, number>;

interface CommitChurn {
  readonly sha: string;
  /** Committer time: when it landed on the default branch. */
  readonly landedAt: string;
  /** Local calendar day it landed, `YYYY-MM-DD`. */
  readonly day: string;
  readonly lines: ChurnLines;
  /** Buckets the commit touched, including binary files and renames with no changed lines. */
  readonly buckets: readonly ChurnBucket[];
  /** Issue keys its message names. */
  readonly issueKeys: readonly string[];
}

export type RepositoryChurn =
  | {
      readonly state: "known";
      readonly ref: string;
      readonly head: string;
      /** Every local day in the window, zero-filled, oldest first. */
      readonly days: readonly { readonly day: string; readonly lines: ChurnLines }[];
      readonly commits: readonly CommitChurn[];
    }
  | { readonly state: "unknown"; readonly reason: string };

export interface ChurnWindow {
  readonly since: Date;
  /** Exclusive; defaults to now. */
  readonly until?: Date;
  /** The project's declared product globs, relative to the repository root. */
  readonly productPaths?: readonly string[];
  /** IANA zone for calendar days; defaults to the service's local zone. */
  readonly timeZone?: string;
}

interface ChangedFile {
  readonly path: string;
  /** Undefined for a binary file. */
  readonly lines?: number;
}

interface CommitRecord {
  readonly sha: string;
  readonly landedAt: number;
  readonly issueKeys: readonly string[];
  readonly files: readonly ChangedFile[];
}

const ORIGIN_REFS = ["origin/HEAD", "origin/main"] as const;
const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
/** Commits are immutable, so a SHA's numstat never goes stale; the cap only bounds memory. */
const CACHE_LIMIT = 50_000;
const SHAS_PER_READ = 500;
const commitCache = new Map<string, CommitRecord>();

const LOCKFILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "composer.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "go.sum",
  "Podfile.lock",
  "Package.resolved",
  "packages.lock.json",
  "flake.lock",
  "mix.lock",
  "pubspec.lock",
]);
const GENERATED =
  /(^|\/)(generated|__generated__)\/|\.generated\.[^/]+$|\.min\.(js|css)$|\.(js|css)\.map$|\.pb\.go$|_pb2\.py$/u;
const DOCS = /(^|\/)docs\/|\.(md|mdx|markdown)$/iu;
const TOOLING =
  /(^|\/)(tests?|__tests__|specs?|fixtures?|__fixtures__|testdata|e2e|rigs?|scripts?|tools?|tooling|ci|\.github|\.circleci|\.buildkite)\/|(^|\/)(\.gitlab-ci\.yml|Jenkinsfile)$|\.(test|spec)\.[^/]+$/u;

function matchesProductPath(path: string, pattern: string): boolean {
  const glob = pattern.replace(/^\.?\/+/u, "").replace(/\/+$/u, "");
  return glob !== "" && (posix.matchesGlob(path, glob) || posix.matchesGlob(path, `${glob}/**`));
}

/**
 * ADR 0270's rule. Lockfiles, generated and binary files are excluded; declared product
 * globs come next, and once a project declares them nothing outside them is product.
 * Then `docs/` and Markdown are docs, test/fixture/rig/script/tool/CI paths are tooling,
 * and the rest is product only for a project that declared nothing.
 */
function churnBucket(path: string, productPaths: readonly string[] | undefined, binary = false): ChurnBucket {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (binary || LOCKFILES.has(name) || GENERATED.test(path)) return "excluded";
  if (productPaths?.some((pattern) => matchesProductPath(path, pattern))) return "product";
  if (DOCS.test(path)) return "docs";
  if (TOOLING.test(path)) return "tooling";
  return productPaths?.length ? "tooling" : "product";
}

/** Tracker identifiers, including built-in `LOCAL-TEAM-n` keys whole, never as `TEAM-n`. */
const issueKeys = (message: string) => [
  ...new Set(message.match(/\b(?:LOCAL-[A-Z][A-Z0-9]*|[A-Z][A-Z0-9]*)-\d+\b/gu) ?? []),
];

async function git(repository: string, args: readonly string[]) {
  return run("git", ["-C", repository, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER });
}

const failure = (error: unknown) =>
  ((error as { stderr?: string }).stderr?.trim() || (error as Error).message).split("\n")[0]!;

/** The origin default branch as last fetched; no fetch happens here. */
export async function originDefaultBranch(
  repository: string,
): Promise<{ ref: string; head: string } | { reason: string }> {
  for (const ref of ORIGIN_REFS) {
    try {
      const { stdout } = await git(repository, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      return { ref, head: stdout.trim() };
    } catch (error) {
      // --quiet keeps a missing ref silent; anything on stderr means the repository itself is unreadable.
      if ((error as { stderr?: string }).stderr?.trim()) {
        return { reason: `repository unreadable: ${failure(error)}` };
      }
    }
  }
  return { reason: `no fetched origin default branch (${ORIGIN_REFS.join(", ")})` };
}

/** Parses `git log -z --numstat` with the `\x1e%H\x1f%ct\x1f%B\x1f` format. */
function parseCommits(stdout: string): CommitRecord[] {
  const commits: CommitRecord[] = [];
  for (const chunk of stdout.split("\x1e").slice(1)) {
    const [sha, landedAt, message, rest = ""] = chunk.split("\x1f");
    const files: ChangedFile[] = [];
    const tokens = rest.split("\0");
    for (let index = 0; index < tokens.length; index += 1) {
      const entry = /^\n?(\d+|-)\t(\d+|-)\t(.*)$/su.exec(tokens[index]!);
      if (entry === null) continue;
      // A rename leaves the path empty and follows with source and destination tokens.
      const path = entry[3] === "" ? tokens[(index += 2)]! : entry[3]!;
      files.push(entry[1] === "-" ? { path } : { path, lines: Number(entry[1]) + Number(entry[2]) });
    }
    commits.push({ sha: sha!, landedAt: Number(landedAt) * 1000, issueKeys: issueKeys(message!), files });
  }
  return commits;
}

async function readCommits(repository: string, shas: readonly string[]): Promise<void> {
  for (let start = 0; start < shas.length; start += SHAS_PER_READ) {
    const { stdout } = await git(repository, [
      "log",
      "-z",
      "-M",
      "--numstat",
      "--diff-merges=first-parent",
      "--no-walk=unsorted",
      "--format=%x1e%H%x1f%ct%x1f%B%x1f",
      ...shas.slice(start, start + SHAS_PER_READ),
    ]);
    for (const commit of parseCommits(stdout)) {
      if (commitCache.size >= CACHE_LIMIT) commitCache.delete(commitCache.keys().next().value!);
      commitCache.set(commit.sha, commit);
    }
  }
}

const zero = (): ChurnLines => ({ product: 0, tooling: 0, docs: 0, excluded: 0 });

function dayFormatter(timeZone: string | undefined) {
  const format = new Intl.DateTimeFormat("en-CA", {
    ...(timeZone === undefined ? {} : { timeZone }),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return (at: number) => format.format(at);
}

/**
 * Lines added plus deleted per local day on the repository's fetched origin default branch,
 * bucketed by ADR 0270's rule, with each commit's buckets and issue keys. Changes are dated by
 * the day they landed: committer time over first-parent history, a merge carrying the work it
 * brought in. Per-commit numstat is cached by SHA, so rereading a window costs one history
 * listing. Never zero for an unreadable source.
 */
export async function readRepositoryChurn(repository: string, window: ChurnWindow): Promise<RepositoryChurn> {
  const since = window.since.getTime();
  const until = (window.until ?? new Date()).getTime();
  const branch = await originDefaultBranch(repository);
  if ("reason" in branch) return { state: "unknown", reason: branch.reason };
  let listed: string;
  try {
    ({ stdout: listed } = await git(repository, [
      "log",
      "--first-parent",
      `--since=${window.since.toISOString()}`,
      "--format=%H %ct",
      branch.head,
    ]));
  } catch (error) {
    return { state: "unknown", reason: `history unreadable: ${failure(error)}` };
  }
  const shas = listed
    .split("\n")
    .map((line) => line.split(" "))
    .filter(([sha, at]) => sha && Number(at) * 1000 >= since && Number(at) * 1000 < until)
    .map(([sha]) => sha!)
    .reverse();
  try {
    await readCommits(
      repository,
      shas.filter((sha) => !commitCache.has(sha)),
    );
  } catch (error) {
    return { state: "unknown", reason: `numstat unreadable: ${failure(error)}` };
  }

  const dayOf = dayFormatter(window.timeZone);
  const days = new Map<string, ChurnLines>();
  for (let at = since; at < until; at += 3_600_000) days.set(dayOf(at), zero());
  if (until > since) days.set(dayOf(until - 1), zero());
  const commits = shas.map((sha): CommitChurn => {
    const record = commitCache.get(sha)!;
    const lines = zero();
    const buckets = new Set<ChurnBucket>();
    for (const file of record.files) {
      const bucket = churnBucket(file.path, window.productPaths, file.lines === undefined);
      buckets.add(bucket);
      lines[bucket] += file.lines ?? 0;
    }
    const day = dayOf(record.landedAt);
    const total = days.get(day)!;
    for (const bucket of buckets) total[bucket] += lines[bucket];
    return {
      sha,
      landedAt: new Date(record.landedAt).toISOString(),
      day,
      lines,
      buckets: [...buckets],
      issueKeys: record.issueKeys,
    };
  });
  return {
    state: "known",
    ref: branch.ref,
    head: branch.head,
    days: [...days].map(([day, lines]) => ({ day, lines })),
    commits,
  };
}
