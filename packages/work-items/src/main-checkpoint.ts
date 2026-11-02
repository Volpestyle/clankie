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

/** GitHub's compare collection excludes the base's ancestors. Walk its first-parent
 * chain to the first main commit containing head, including head itself on main.
 * No local tracking ref, PR check or cancelled run is evidence about main. */
export async function mainCheckpoint(
  api: GithubApi,
  repo: string,
  head: string,
  options: { ignoreUnlanded?: boolean } = {},
): Promise<MainCheckpointHold | undefined> {
  let merge: string | undefined;
  let observed: MainCheckpointHold | undefined;
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
      return options.ignoreUnlanded ? undefined : unknown("Landed HEAD is not an ancestor of main");
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
    merge = chain[low]!;
    let held: MainCheckpointHold | undefined;
    // Newest attempts first; ignore superseded attempts and cancelled runs. A
    // green descendant can cover a merge whose own run never finished.
    const seen = new Set<string>();
    runs: for (let page = 1; page <= 20; page++) {
      const response = (await api.request(
        "GET",
        `${base}/actions/runs?branch=main&event=push&per_page=100&page=${page}`,
      )) as { workflow_runs: Run[]; total_count: number };
      for (const run of response.workflow_runs) {
        if (run.event !== "push" || run.head_branch !== "main" || run.conclusion === "cancelled") continue;
        const coverage: Comparison | undefined =
          run.head_sha === merge
            ? undefined
            : ((await api.request(
                "GET",
                `${base}/compare/${merge}...${run.head_sha}?per_page=1`,
              )) as Comparison);
        if (coverage?.status === "behind" && coverage.merge_base_commit.sha === run.head_sha) break runs;
        if (
          coverage &&
          (coverage.merge_base_commit.sha !== merge || !["ahead", "identical"].includes(coverage.status))
        )
          continue;
        const runJobs: Job[] = [];
        for (let jobPage = 1; jobPage <= 20; jobPage++) {
          const jobs = (await api.request(
            "GET",
            `${base}/actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${jobPage}`,
          )) as { jobs: Job[]; total_count: number };
          runJobs.push(...jobs.jobs);
          if (runJobs.length >= jobs.total_count) break;
          if (!jobs.jobs.length || jobPage === 20) throw new Error("Incomplete checkpoint jobs");
        }
        if (!runJobs.some((job) => jobsRequired.includes(job.name))) continue;
        if (seen.has(run.head_sha)) continue;
        seen.add(run.head_sha);
        const selected = jobsRequired.map((name) => runJobs.find((job) => job.name === name));
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
        const candidate: MainCheckpointHold = {
          reason: run.status === "completed" && failingJobs.length ? "main_red" : "main_pending",
          commit: merge,
          runUrl: run.html_url,
          failingJobs,
        };
        if (!held) held = candidate;
        observed = held;
        if (candidate.reason === "main_red" && (await linkedCheckpointBug(api, repo, merge, run.html_url)))
          return undefined;
      }
      if (response.workflow_runs.length < 100 || page * 100 >= response.total_count) break;
    }
    return held ?? unknown("No completed post-merge checkpoint result", merge);
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
): Promise<boolean> {
  const namesRun = (text: string) =>
    (text.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/actions\/runs\/\d+/gu) ?? []).some(
      (url) => url === runUrl,
    ) || (text.match(/\b[a-f0-9]{7,64}\b/giu) ?? []).some((sha) => commit.startsWith(sha.toLowerCase()));
  for (const term of [runUrl, commit, commit.slice(0, 12), commit.slice(0, 8), commit.slice(0, 7)]) {
    const q = encodeURIComponent(`repo:${repo} is:issue "${term}"`);
    for (let page = 1; page <= 10; page++) {
      const found = (await api.request("GET", `search/issues?q=${q}&per_page=100&page=${page}`)) as {
        items: { number: number; title: string; body: string | null; pull_request?: unknown }[];
        total_count: number;
        incomplete_results?: boolean;
      };
      if (found.incomplete_results) throw new Error("Incomplete bug search");
      for (const issue of found.items) {
        if (issue.pull_request) continue;
        if (namesRun(`${issue.title}\n${issue.body ?? ""}`)) return true;
        const comments = (await api.list(`repos/${repo}/issues/${issue.number}/comments?per_page=100`)) as {
          body: string;
        }[];
        if (comments.some((comment) => namesRun(comment.body))) return true;
      }
      if (page * 100 >= found.total_count) break;
    }
  }
  return false;
}
