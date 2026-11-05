import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubRestApi } from "@clankie/work-items";

/** A loopback GitHub REST recorder backed by real, exclusively owned bare Git repos. */
export async function trackingForge() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tracking-forge-")));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" };
  const git = (path: string, args: string[], input?: string): Promise<string> => new Promise((resolve, reject) => {
    const child = execFile("git", ["-C", path, ...args], { env, timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin?.end(input);
  });
  const repos = new Map<string, { path: string; private: boolean; pulls: any[] }>();
  const calls: { method: string; path: string; body: any }[] = [];
  let before: ((method: string, path: string) => Promise<void>) | undefined;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url!, "http://fixture");
      const path = decodeURIComponent(url.pathname.replace(/\/$/u, ""));
      const match = /^\/repos\/([^/]+\/[^/]+)(?:\/(.*))?$/u.exec(path);
      const repo = match ? repos.get(match[1]!) : undefined;
      if (!repo || !match) { response.writeHead(404).end(); return; }
      const method = request.method!;
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ method, path, body });
      await before?.(method, path);
      const rest = match[2] ?? "";
      let value: unknown;
      const run = (args: string[], input?: string) => git(repo.path, args, input);
      const tree = async (sha: string) => (await run(["ls-tree", "-z", sha])).split("\0").filter(Boolean).map((row) => {
        const [mode, type, shaAndPath] = row.split(" ");
        const tab = shaAndPath!.indexOf("\t");
        return { mode: mode!, type: type!, sha: shaAndPath!.slice(0, tab), path: shaAndPath!.slice(tab + 1) };
      });
      if (method === "GET" && !rest) value = { full_name: match[1], private: repo.private, default_branch: "main" };
      else if (method === "GET" && rest.startsWith("git/ref/heads/")) value = { object: { sha: (await run(["rev-parse", "refs/heads/" + rest.slice(14)])).trim() } };
      else if (method === "GET" && rest.startsWith("git/commits/")) {
        const raw = await run(["cat-file", "-p", rest.slice(12)]);
        value = { tree: { sha: /^tree (\w+)$/mu.exec(raw)![1] }, parents: [...raw.matchAll(/^parent (\w+)$/gmu)].map((m) => ({ sha: m[1] })) };
      } else if (method === "GET" && rest.startsWith("git/trees/")) value = { truncated: false, tree: await tree(rest.slice(10)) };
      else if (method === "GET" && rest.startsWith("git/blobs/")) {
        const content = Buffer.from(await run(["cat-file", "blob", rest.slice(10)]));
        value = { encoding: "base64", content: content.toString("base64"), size: content.length };
      } else if (method === "GET" && rest === "pulls") value = repo.pulls.filter((pull) => pull.state === "open");
      else if (method === "POST" && rest === "git/trees") {
        const entries = await tree(body.base_tree);
        for (const item of body.tree) {
          const sha = (await run(["hash-object", "-w", "--stdin"], item.content)).trim();
          const existing = entries.find((entry) => entry.path === item.path);
          if (existing) Object.assign(existing, { sha, mode: item.mode, type: item.type });
          else entries.push({ path: item.path, sha, mode: item.mode, type: item.type });
        }
        value = { sha: (await run(["mktree"], entries.map((entry) => `${entry.mode} ${entry.type} ${entry.sha}\t${entry.path}\n`).join(""))).trim() };
      } else if (method === "POST" && rest === "git/commits") value = { sha: (await run(["commit-tree", body.tree, ...body.parents.flatMap((sha: string) => ["-p", sha]), "-m", body.message])).trim() };
      else if (method === "POST" && rest === "git/refs") { await run(["update-ref", body.ref, body.sha, "0".repeat(40)]); value = { ref: body.ref, object: { sha: body.sha } }; }
      else if (method === "POST" && rest === "pulls") {
        value = { number: repo.pulls.length + 1, html_url: `https://github.com/${match[1]}/pull/${repo.pulls.length + 1}`, body: body.body, head: { ref: body.head, repo: { full_name: match[1] } }, base: { ref: body.base }, state: "open" };
        repo.pulls.push(value);
      } else throw new Error(`Unrecorded fixture route ${method} ${rest}`);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(value));
    } catch (error) { response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ message: String(error) })); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const api = githubRestApi({ token: "fixture-only", baseUrl: "http://127.0.0.1:" + (server.address() as { port: number }).port });
  return {
    root, api, calls,
    before: (hook?: typeof before) => { before = hook; },
    async repo(name: string, guide: string, visibility = false, file = "CLAUDE.md", mode = "100644") {
      const path = join(root, name.replace("/", "-")); await mkdir(path);
      await git(path, ["init", "--bare", "--initial-branch=main"]);
      const blob = (await git(path, ["hash-object", "-w", "--stdin"], guide)).trim();
      const owner = (await git(path, ["hash-object", "-w", "--stdin"], "Owner file\n")).trim();
      const tree = (await git(path, ["mktree"], `${mode} blob ${blob}\t${file}\n100644 blob ${owner}\towner.txt\n`)).trim();
      const sha = (await git(path, ["commit-tree", tree, "-m", "Initial fixture"])).trim();
      await git(path, ["update-ref", "refs/heads/main", sha]);
      const repo = { path, private: visibility, pulls: [] as any[] }; repos.set(name, repo);
      return {
        path,
        pulls: repo.pulls,
        read: (ref = "main", guideFile = file) => git(path, ["show", `${ref}:${guideFile}`]),
        diff: (ref: string) => git(path, ["diff", "--name-only", "main", ref]),
        async merge() { const pull = repo.pulls.find((p) => p.state === "open"); if (!pull) throw new Error("No pending fixture PR"); await git(path, ["update-ref", "refs/heads/main", (await git(path, ["rev-parse", "refs/heads/" + pull.head.ref])).trim()]); pull.state = "closed"; },
        async checkout() {
          const checkout = path + "-checkout"; await mkdir(checkout);
          await git(checkout, ["clone", path, "."]);
          await git(checkout, ["remote", "set-url", "origin", `https://github.com/${name}.git`]);
          return checkout;
        },
        async commitGuide(content: string, message: string, checkout: string) {
          await writeFile(join(checkout, file), content);
          await git(checkout, ["add", file]); await git(checkout, ["commit", "-m", message]);
        },
      };
    },
    async close() { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); await rm(root, { recursive: true, force: true }); },
  };
}
