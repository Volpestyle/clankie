import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { githubRestApi } from "../../src/backends/github.ts";
import { mainCheckpoint, MainCheckpointCache } from "../../src/main-checkpoint.ts";

/** Real Git DAG, HTTP boundary and production GitHub transport. Only the remote
 * Actions/issue service is a controlled fixture; no live job or issue is changed. */
export async function checkpointFixture() {
  const root = await mkdtemp(join(tmpdir(), "main-checkpoint-"));
  const git = async (...args: string[]) =>
    (await promisify(execFile)("git", ["-C", root, ...args])).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  const commit = async (file: string) => {
    await writeFile(join(root, file), file);
    await git("add", file);
    await git("commit", "-m", file);
    return git("rev-parse", "HEAD");
  };
  const start = await commit("base");
  await git("update-ref", "refs/remotes/origin/main", start);
  await git("checkout", "-b", "worker");
  const head = await commit("worker");
  await git("checkout", "main");
  const parallel = await commit("parallel-main");
  await git("update-ref", "refs/remotes/origin/main", parallel);
  await git("merge", "--no-ff", "worker", "-m", "land worker");
  const merge = await git("rev-parse", "HEAD");
  await git("update-ref", "refs/remotes/origin/main", merge);
  const tip = await commit("later-main");
  await git("update-ref", "refs/remotes/origin/main", tip);
  await git("init", "--bare", join(root, ".git", "fixture-origin.git"));
  await git("remote", "add", "origin", join(root, ".git", "fixture-origin.git"));
  await git("push", "origin", "main");
  await git("checkout", "worker");
  const runUrl = "https://github.com/fixture/repo/actions/runs/280";
  let mode = "red";
  let now = 0;
  const cache = new MainCheckpointCache(() => now);
  let linked:
    | "sha"
    | "sha-jobs"
    | "sha-partial"
    | "sha-comment"
    | "url"
    | "comment"
    | "descendant-url"
    | undefined;
  const requests: string[] = [];
  // A busy main: this many green pushes after the merge, newest first, with each
  // GitHub comparison taking compareMs, as a large repository's do.
  let busy = { later: 0, compareMs: 0 };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, "http://fixture");
      requests.push(url.pathname + url.search);
      if (mode === "unreachable" || mode === "rate-limited") {
        response.writeHead(mode === "rate-limited" ? 429 : 503).end();
        return;
      }
      let data: unknown;
      if (url.pathname === "/repos/fixture/repo/issues/280/parent") {
        response.writeHead(404).end();
        return;
      } else if (url.pathname === "/repos/fixture/repo/issues/280/timeline")
        data = [
          {
            event: "cross-referenced",
            source: {
              issue: { pull_request: { url: "https://api.github.com/repos/fixture/repo/pulls/279" } },
            },
          },
        ];
      else if (url.pathname === "/repos/fixture/repo/pulls/279") data = { merged: true, head: { sha: head } };
      else if (url.pathname === "/repos/fixture/repo/issues/280")
        data = {
          number: 280,
          title: "Merged job",
          body: "Acceptance evidence",
          labels: [],
          state: request.method === "PATCH" ? "closed" : "open",
          state_reason: request.method === "PATCH" ? "completed" : null,
          html_url: "https://github.com/fixture/repo/issues/280",
        };
      else if (url.pathname === "/repos/fixture/repo/commits/main") data = { sha: tip };
      else if (url.pathname.includes("/compare/")) {
        if (busy.compareMs) await new Promise((resolve) => setTimeout(resolve, busy.compareMs));
        const [base, target] = url.pathname.split("/compare/")[1]!.split("...") as [string, string];
        const ancestor = await git("merge-base", base, target);
        const shas = (await git("rev-list", "--reverse", `${base}..${target}`)).split("\n").filter(Boolean);
        const commits = await Promise.all(
          shas.map(async (sha) => ({
            sha,
            parents: (await git("show", "-s", "--format=%P", sha))
              .split(" ")
              .filter(Boolean)
              .map((sha) => ({ sha })),
          })),
        );
        data = {
          status: base === target ? "identical" : ancestor === base ? "ahead" : "diverged",
          merge_base_commit: { sha: ancestor },
          commits,
          total_commits: commits.length,
        };
      } else if (url.pathname === "/repos/fixture/repo/actions/runs") {
        const run = (id: number, sha: string, status: string, conclusion: string | null) => ({
          id,
          head_sha: sha,
          html_url: `https://github.com/fixture/repo/actions/runs/${id}`,
          status,
          conclusion,
          event: "push",
          head_branch: "main",
        });
        const runs =
          mode === "descendant" || mode === "missing-own"
            ? [
                run(281, tip, "completed", "success"),
                ...(mode === "missing-own" ? [] : [run(280, merge, "completed", "cancelled")]),
              ]
            : [
                  "red-descendant",
                  "green-descendant-red-own",
                  "red-descendant-green-own",
                  "green-descendant-running-own",
                  "red-descendant-cancelled-own",
                  "running-descendant-red-finished-cancelled-own",
                ].includes(mode)
              ? [
                  ...(mode.startsWith("running-descendant") ? [run(282, tip, "in_progress", null)] : []),
                  run(281, tip, "completed", mode.startsWith("green-descendant") ? "success" : "failure"),
                  run(
                    280,
                    merge,
                    mode.endsWith("running-own") ? "in_progress" : "completed",
                    mode.endsWith("green-own")
                      ? "success"
                      : mode.endsWith("cancelled-own")
                        ? "cancelled"
                        : "failure",
                  ),
                ]
              : mode === "no-runs"
                ? []
                : [
                    run(
                      280,
                      mode === "unrelated" || mode === "unknown" ? parallel : merge,
                      mode === "running" ? "in_progress" : "completed",
                      mode === "cancelled" ? "cancelled" : mode === "green" ? "success" : "failure",
                    ),
                  ];
        const all = [
          ...Array.from({ length: busy.later }, (_, index) =>
            run(10_000 - index, tip, "completed", "success"),
          ),
          ...runs,
        ].filter(
          (entry) => !url.searchParams.has("head_sha") || entry.head_sha === url.searchParams.get("head_sha"),
        );
        const size = Number(url.searchParams.get("per_page") ?? 30);
        const page = Number(url.searchParams.get("page") ?? 1);
        data = { workflow_runs: all.slice((page - 1) * size, page * size), total_count: all.length };
      } else if (/\/actions\/runs\/\d+\/jobs$/u.test(url.pathname)) {
        const own = url.pathname.includes("/runs/280/");
        const success =
          mode === "green" ||
          mode === "descendant" ||
          mode === "missing-own" ||
          (own ? mode === "red-descendant-green-own" : mode.startsWith("green-descendant"));
        const running = mode === "running" || (own && mode.endsWith("running-own"));
        const jobs = ["landing", "checkpoint", "mac", "check"]
          .filter(
            (name) =>
              (mode !== "missing-job" || name !== "mac") && (mode !== "no-checkpoint" || name === "check"),
          )
          .map((name) => ({
            name,
            status: running ? "in_progress" : "completed",
            conclusion: running ? null : success || name === "check" ? "success" : "failure",
          }));
        data = { jobs, total_count: jobs.length };
      } else if (url.pathname === "/search/issues") {
        data = {
          total_count: linked ? 1 : 0,
          items: linked
            ? [
                {
                  number: 286,
                  title: "Checkpoint regression",
                  body:
                    linked === "sha"
                      ? `Restart failure, base ${merge.slice(0, 8)}`
                      : linked === "sha-jobs"
                        ? `${merge.slice(0, 8)}: landing, checkpoint, mac`
                        : linked === "sha-partial"
                          ? `${merge.slice(0, 8)}: checkpoint`
                          : linked === "url"
                            ? runUrl
                            : linked === "descendant-url"
                              ? runUrl.replace("280", "281")
                              : "See comments",
                  state: "closed",
                },
              ]
            : [],
        };
      } else if (url.pathname === "/repos/fixture/repo/issues/286/comments")
        data = [
          {
            body:
              linked === "comment"
                ? runUrl
                : linked === "sha-comment"
                  ? `Restart failure, base ${merge}`
                  : "unrelated",
          },
        ];
      else throw new Error(`Unexpected fixture request ${url.pathname}`);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(data));
    } catch (error) {
      response.writeHead(500).end(String(error));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture listen failed");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const api = githubRestApi({ token: "fixture-only", baseUrl });
  return {
    root,
    start,
    cache,
    clock: () => new Date(now),
    advance: (ms = 180_001) => {
      now += ms;
    },
    head,
    merge,
    tip,
    parallel,
    runUrl,
    requests,
    api,
    baseUrl,
    git,
    check: () => mainCheckpoint(api, "fixture/repo", head, { cache }),
    mode: (next: string) => {
      mode = next;
    },
    busy: (later: number, compareMs: number) => {
      busy = { later, compareMs };
    },
    link: (next: typeof linked, expire = true) => {
      linked = next;
      if (expire) now += 180_001;
    },
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}
