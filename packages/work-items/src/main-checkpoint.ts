import type { GithubApi } from "./backends/github.ts";

export interface MainCheckpointHold {
  readonly reason: "main_red" | "main_pending" | "main_unknown";
  readonly commit?: string;
  readonly runUrl?: string;
  readonly failingJobs: readonly string[];
  readonly detail?: string;
}
export class MainCheckpointRefused extends Error {
  readonly hold: MainCheckpointHold;
  constructor(hold: MainCheckpointHold) {
    super(
      `${hold.reason}: ${hold.commit ?? "merge unknown"}${hold.runUrl ? ` ${hold.runUrl}` : ""}${hold.failingJobs.length ? ` (${hold.failingJobs.join(", ")})` : ""}${hold.detail ? `: ${hold.detail}` : ""}`,
    );
    this.hold = hold;
  }
}
interface Commit {
  sha: string;
  parents: { sha: string }[];
}
interface Comparison {
  status: string;
  merge_base_commit: Commit;
  commits: Commit[];
  total_commits: number;
}
interface Run {
  id: number;
  head_sha: string;
  html_url: string;
  status: string;
  conclusion: string | null;
  event: string;
  head_branch: string;
}
interface Job {
  name: string;
  status: string;
  conclusion: string | null;
}
const jobsRequired = ["landing", "checkpoint", "mac"];
const unknown = (detail: string, commit?: string): MainCheckpointHold => ({
  reason: "main_unknown",
  failingJobs: [],
  detail,
  ...(commit ? { commit } : {}),
});

/** A connection owns its cache: no results or issue reads cross credentials.
 * Pending promises coalesce concurrent panes; settled results (including read
 * failures) expire after three minutes, so filing a bug is observed on retry. */
export class MainCheckpointCache {
  private readonly entries = new Map<string, { until: number; promise: Promise<unknown> }>();
  private readonly now: () => number;
  constructor(now: () => number = Date.now) {
    this.now = now;
  }
  read<T>(key: string, load: () => Promise<T>): Promise<T> {
    const prior = this.entries.get(key);
    if (prior && prior.until > this.now()) return prior.promise as Promise<T>;
    for (const [key, entry] of this.entries) if (entry.until <= this.now()) this.entries.delete(key);
    if (this.entries.size >= 512) this.entries.delete(this.entries.keys().next().value!);
    const entry = { until: Infinity, promise: Promise.resolve() as Promise<unknown> };
    entry.promise = Promise.resolve()
      .then(load)
      .finally(() => {
        entry.until = this.now() + 3 * 60_000;
      });
    this.entries.set(key, entry);
    return entry.promise as Promise<T>;
  }
}
const connectionCaches = new WeakMap<GithubApi, MainCheckpointCache>();

async function recentRuns(api: GithubApi, repo: string, cache: MainCheckpointCache, page = 1) {
  return cache.read(
    `runs:${repo}:${page}`,
    async () =>
      (await api.request(
        "GET",
        `repos/${repo}/actions/runs?branch=main&event=push&per_page=100&page=${page}`,
      )) as { workflow_runs: Run[]; total_count: number },
  );
}
async function checkpointJobs(api: GithubApi, repo: string, cache: MainCheckpointCache, runId: number) {
  return cache.read(`jobs:${repo}:${runId}`, async () => {
    const all: Job[] = [];
    for (let page = 1; page <= 20; page++) {
      const result = (await api.request(
        "GET",
        `repos/${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`,
      )) as { jobs: Job[]; total_count: number };
      all.push(...result.jobs);
      if (all.length >= result.total_count) return all;
      if (!result.jobs.length) break;
    }
    throw new Error("Incomplete checkpoint jobs");
  });
}

export async function mainCheckpoint(
  api: GithubApi,
  repo: string,
  head: string,
  options: { ignoreUnlanded?: boolean; cache?: MainCheckpointCache } = {},
): Promise<MainCheckpointHold | undefined> {
  let cache = options.cache ?? connectionCaches.get(api);
  if (!cache) {
    cache = new MainCheckpointCache();
    connectionCaches.set(api, cache);
  }
  const scoped = cache;
  try {
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repo) || !/^[a-f0-9]{40,64}$/u.test(head))
      return unknown("Invalid repository or landed HEAD");
    // Capability is a repository observation, not a missing result for this job.
    // Include cancelled/older runs here: their job names still prove a checkpoint
    // exists, though they cannot prove this merge passed.
    const configured = await scoped.read(`configured:${repo}`, async () => {
      const runs = await recentRuns(api, repo, scoped);
      for (const run of runs.workflow_runs.slice(0, 20)) {
        if (
          run.event === "push" &&
          run.head_branch === "main" &&
          (await checkpointJobs(api, repo, scoped, run.id)).some((job) => jobsRequired.includes(job.name))
        )
          return true;
      }
      return false;
    });
    if (!configured) return undefined;
    const merge = await scoped.read(`head:${repo}:${head}`, () => resolveMainMerge(api, repo, head));
    if (typeof merge !== "string")
      return options.ignoreUnlanded && merge.detail === "Landed HEAD is not an ancestor of main"
        ? undefined
        : merge;
    return await scoped.read(`merge:${repo}:${merge}`, () => observeCheckpoint(api, repo, merge, scoped));
  } catch {
    return unknown("GitHub checkpoint observation unavailable");
  }
}

/** Resolve the first main commit containing head, including parallel main work. */
async function resolveMainMerge(
  api: GithubApi,
  repo: string,
  head: string,
): Promise<string | MainCheckpointHold> {
  try {
    if (!/^[\w.-]+\/[\w.-]+$/u.test(repo) || !/^[a-f0-9]{40,64}$/u.test(head))
      return unknown("Invalid repository or landed HEAD");
    const base = `repos/${repo}`;
    const tip = (await api.request("GET", `${base}/commits/main`)) as Commit;
    const comparison = (await api.request(
      "GET",
      `${base}/compare/${head}...${tip.sha}?per_page=100&page=1`,
    )) as Comparison;
    if (comparison.merge_base_commit.sha !== head || !["ahead", "identical"].includes(comparison.status))
      return unknown("Landed HEAD is not an ancestor of main");
    const commits = [...comparison.commits];
    if (comparison.total_commits > 2000) return unknown("Main ancestry exceeds observation limit");
    for (let page = 2; commits.length < comparison.total_commits; page++) {
      const next = (await api.request(
        "GET",
        `${base}/compare/${head}...${tip.sha}?per_page=100&page=${page}`,
      )) as Comparison;
      if (!next.commits.length) return unknown("Incomplete main ancestry");
      commits.push(...next.commits);
    }
    const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
    const chain: string[] = [];
    let cursor = tip.sha;
    for (let count = 0; count <= commits.length; count++) {
      chain.push(cursor);
      if (cursor === head) break;
      const commit = bySha.get(cursor);
      if (!commit?.parents.length) return unknown("Incomplete first-parent ancestry");
      const parent = commit.parents[0]!.sha;
      if (parent !== head && !bySha.has(parent)) break;
      cursor = parent;
    }
    // Parallel main commits after the fork are in compare's collection too.
    // Binary-search containment on the first-parent chain, rather than treating
    // the oldest comparison commit as the merge.
    let low = 0,
      high = chain.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      const candidate = chain[mid]!;
      const contains =
        candidate === head ||
        ((await api.request("GET", `${base}/compare/${head}...${candidate}?per_page=1`)) as Comparison)
          .merge_base_commit.sha === head;
      if (contains) low = mid;
      else high = mid - 1;
    }
    return chain[low]!;
  } catch {
    return unknown("GitHub checkpoint observation unavailable");
  }
}

async function observeCheckpoint(
  api: GithubApi,
  repo: string,
  merge: string,
  cache: MainCheckpointCache,
): Promise<MainCheckpointHold | undefined> {
  let observed: MainCheckpointHold | undefined;
  const base = `repos/${repo}`;
  try {
    // Prefer this merge's newest checkpoint, even while it is running. GitHub finds the
    // merge's own runs by head SHA: walking every later push to reach them cost a
    // comparison per run and outlasted every close on a busy main (#746).
    const required = (jobs: Job[]) => jobs.some((job) => jobsRequired.includes(job.name));
    const owned = (await cache.read(
      `own:${repo}:${merge}`,
      async () =>
        (await api.request(
          "GET",
          `${base}/actions/runs?branch=main&event=push&head_sha=${merge}&per_page=100`,
        )) as { workflow_runs: Run[]; total_count: number },
    )) as { workflow_runs: Run[]; total_count: number };
    let own: { run: Run; jobs: Job[] } | undefined;
    for (const run of owned.workflow_runs) {
      if (run.event !== "push" || run.head_branch !== "main" || run.head_sha !== merge) continue;
      const jobs = await checkpointJobs(api, repo, cache, run.id);
      if (required(jobs)) {
        own = { run, jobs };
        break;
      }
    }
    if (!own)
      return unknown(
        owned.total_count > owned.workflow_runs.length
          ? "Checkpoint observation limit reached"
          : "No merge checkpoint result",
        merge,
      );
    // Only a cancelled own run permits coverage by a descendant; unrelated workflows
    // and older green runs cannot discharge its red result.
    let descendant: { run: Run; jobs: Job[] } | undefined;
    if (own.run.conclusion === "cancelled")
      runs: for (let page = 1; page <= 20; page++) {
        const response = await recentRuns(api, repo, cache, page);
        for (const run of response.workflow_runs) {
          if (run.event !== "push" || run.head_branch !== "main") continue;
          // Runs are newest first: the merge's own run ends the descendants.
          if (run.head_sha === merge) break runs;
          const coverage = (await api.request(
            "GET",
            `${base}/compare/${merge}...${run.head_sha}?per_page=1`,
          )) as Comparison;
          if (coverage.status === "behind" && coverage.merge_base_commit.sha === run.head_sha) break runs;
          if (coverage.merge_base_commit.sha !== merge || !["ahead", "identical"].includes(coverage.status))
            continue;
          if (run.status !== "completed" || run.conclusion === "cancelled") continue;
          const jobs = await checkpointJobs(api, repo, cache, run.id);
          if (!required(jobs)) continue;
          descendant = { run, jobs };
          break runs;
        }
        if (response.workflow_runs.length < 100 || page * 100 >= response.total_count) break;
      }
    const chosen = own.run.conclusion === "cancelled" ? descendant : own;
    if (!chosen) return unknown("No completed post-merge checkpoint result", merge);
    const { run, jobs } = chosen;
    const selected = jobsRequired.map((name) => jobs.find((job) => job.name === name));
    const failingJobs = selected
      .filter(
        (job): job is Job =>
          job !== undefined &&
          job.status === "completed" &&
          ["failure", "timed_out", "action_required", "startup_failure"].includes(job.conclusion ?? ""),
      )
      .map((job) => job.name);
    if (
      run.status === "completed" &&
      selected.every((job) => job?.status === "completed" && job.conclusion === "success")
    )
      return undefined;
    observed = {
      reason: run.status === "completed" && failingJobs.length ? "main_red" : "main_pending",
      commit: merge,
      runUrl: run.html_url,
      failingJobs,
    };
    if (
      observed.reason === "main_red" &&
      (await linkedCheckpointBug(api, repo, run.head_sha, run.html_url, failingJobs, cache))
    )
      return undefined;
    return observed;
  } catch {
    return observed
      ? { ...observed, reason: "main_unknown", detail: "GitHub checkpoint observation unavailable" }
      : unknown("GitHub checkpoint observation unavailable", merge);
  }
}

/** Issue state does not matter. Search includes comments; verify exact text so
 * fuzzy search hits and pull requests never discharge a red checkpoint. */
async function linkedCheckpointBug(
  api: GithubApi,
  repo: string,
  commit: string,
  runUrl: string,
  failingJobs: readonly string[],
  cache: MainCheckpointCache,
): Promise<boolean> {
  const namesRun = (text: string) =>
    (text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+/gu) ?? []).some(
      (url) => url === runUrl,
    ) ||
    ((text.match(/\b[a-f0-9]{7,64}\b/giu) ?? []).some((sha) => commit.startsWith(sha.toLowerCase())) &&
      failingJobs.every((name) => (text.match(/\b[\w-]+\b/gu) ?? []).some((word) => word === name)));
  for (const term of [runUrl, commit, commit.slice(0, 12), commit.slice(0, 8), commit.slice(0, 7)]) {
    const q = encodeURIComponent(`repo:${repo} is:issue "${term}"`);
    for (let page = 1; page <= 10; page++) {
      const found = (await cache.read(`search:${q}:${page}`, () =>
        api.request("GET", `search/issues?q=${q}&per_page=100&page=${page}`),
      )) as {
        items: { number: number; title: string; body: string | null; pull_request?: unknown }[];
        total_count: number;
        incomplete_results?: boolean;
      };
      if (found.incomplete_results) throw new Error("Incomplete bug search");
      for (const issue of found.items) {
        if (issue.pull_request) continue;
        if (namesRun(`${issue.title}\n${issue.body ?? ""}`)) return true;
        const comments = (await cache.read(`comments:${repo}:${issue.number}`, () =>
          api.list(`repos/${repo}/issues/${issue.number}/comments?per_page=100`),
        )) as {
          body: string;
        }[];
        if (comments.some((comment) => namesRun(comment.body))) return true;
      }
      if (page * 100 >= found.total_count) break;
    }
  }
  return false;
}
