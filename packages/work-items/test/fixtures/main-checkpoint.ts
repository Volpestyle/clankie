import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { githubRestApi } from "../../src/backends/github.ts";
import { mainCheckpoint } from "../../src/main-checkpoint.ts";

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
  await commit("base");
  await git("checkout", "-b", "worker");
  const head = await commit("worker");
  await git("checkout", "main");
  const parallel = await commit("parallel-main");
  await git("merge", "--no-ff", "worker", "-m", "land worker");
  const merge = await git("rev-parse", "HEAD");
  const tip = await commit("later-main");
  await git("update-ref", "refs/remotes/origin/main", tip);
  await git("init", "--bare", join(root, ".git", "fixture-origin.git"));
  await git("remote", "add", "origin", join(root, ".git", "fixture-origin.git"));
  await git("push", "origin", "main");
  await git("checkout", "worker");
  const runUrl = "https://github.com/fixture/repo/actions/runs/280";
  let mode = "red";
  let linked: "sha" | "url" | "comment" | undefined;
  const requests: string[] = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, "http://fixture");
      requests.push(url.pathname + url.search);
      if (mode === "unreachable") {
        response.writeHead(503).end();
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
          mode === "descendant"
            ? [run(281, tip, "completed", "success"), run(280, merge, "completed", "cancelled")]
            : mode === "red-descendant"
              ? [run(281, tip, "completed", "failure"), run(280, merge, "completed", "failure")]
              : mode === "unknown"
                ? []
                : [
                    run(
                      280,
                      mode === "unrelated" ? parallel : merge,
                      mode === "running" ? "in_progress" : "completed",
                      mode === "cancelled" ? "cancelled" : mode === "green" ? "success" : "failure",
                    ),
                  ];
        data = { workflow_runs: runs, total_count: runs.length };
      } else if (/\/actions\/runs\/\d+\/jobs$/u.test(url.pathname)) {
        const success = mode === "green" || mode === "descendant";
        const jobs = ["landing", "checkpoint", "mac", "check"]
          .filter((name) => mode !== "missing-job" || name !== "mac")
          .map((name) => ({
            name,
            status: mode === "running" ? "in_progress" : "completed",
            conclusion: mode === "running" ? null : success || name === "check" ? "success" : "failure",
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
                  body: linked === "sha" ? merge.slice(0, 8) : linked === "url" ? runUrl : "See comments",
                  state: "closed",
                },
              ]
            : [],
        };
      } else if (url.pathname === "/repos/fixture/repo/issues/286/comments")
        data = [{ body: linked === "comment" ? runUrl : "unrelated" }];
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
    head,
    merge,
    tip,
    parallel,
    runUrl,
    requests,
    api,
    baseUrl,
    git,
    check: () => mainCheckpoint(api, "fixture/repo", head),
    mode: (next: string) => {
      mode = next;
    },
    link: (next: typeof linked) => {
      linked = next;
    },
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}
