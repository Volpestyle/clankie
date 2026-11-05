import { execFile, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const IDENTITY = [
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "-c",
  "commit.gpgsign=false",
];

interface FixturePull {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged_at: string | null;
  title: string;
  body: string;
  head: { ref: string; sha: string; repo: { full_name: string } };
  base: { ref: string };
}

export interface FixtureFile {
  readonly content: string;
  /** Git mode; `120000` makes `content` a symlink target. */
  readonly mode?: string;
}

/**
 * GitHub's git-data and pull endpoints over real bare repositories, on 127.0.0.1 only. There
 * is no merge endpoint and no issues endpoint: a client that reaches for either gets a 404
 * recorded in `requests`, and merging is the fixture's own `merge`, standing in for a person.
 */
export async function startLoopbackForge() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "loopback-forge-")));
  const pulls = new Map<string, FixturePull[]>();
  const requests: { readonly method: string; readonly path: string }[] = [];
  const bare = (slug: string) => join(root, `${slug}.git`);
  const git = async (slug: string, ...args: string[]) =>
    (
      await run("git", ["-C", bare(slug), ...IDENTITY, ...args], { maxBuffer: 16 * 1024 * 1024 })
    ).stdout.trim();
  const gitInput = (slug: string, input: string | Buffer, ...args: string[]) => {
    const result = spawnSync("git", ["-C", bare(slug), ...IDENTITY, ...args], { input });
    if (result.status !== 0) throw new Error(String(result.stderr));
    return String(result.stdout).trim();
  };
  const commitFiles = async (
    slug: string,
    parent: string | undefined,
    files: Record<string, FixtureFile>,
  ) => {
    const baseEntries = parent ? (await git(slug, "ls-tree", parent)).split("\n").filter(Boolean) : [];
    const entries = new Map(baseEntries.map((line) => [line.split("\t")[1]!, line]));
    for (const [path, file] of Object.entries(files)) {
      const sha = gitInput(slug, file.content, "hash-object", "-w", "--stdin");
      entries.set(path, `${file.mode ?? "100644"} blob ${sha}\t${path}`);
    }
    const tree = gitInput(slug, `${[...entries.values()].join("\n")}\n`, "mktree");
    return git(slug, "commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", "Fixture commit");
  };
  const refOf = (slug: string, branch: string) =>
    git(slug, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`);

  const handle = async (method: string, url: URL, body: Record<string, unknown>) => {
    const parts = /^\/repos\/([^/]+\/[^/]+)(?:\/(.*))?$/u.exec(url.pathname);
    if (!parts) return { status: 404, value: { message: "Not Found" } };
    const slug = parts[1]!;
    const rest = parts[2] ?? "";
    if (!pulls.has(slug)) return { status: 404, value: { message: "Not Found" } };
    const route = `${method} ${rest}`;
    if (route === "GET ") return { status: 200, value: { full_name: slug, default_branch: "main" } };
    let match: RegExpExecArray | null;
    if (method === "GET" && (match = /^git\/ref\/heads\/(.+)$/u.exec(rest))) {
      const sha = await refOf(slug, match[1]!).catch(() => undefined);
      return sha
        ? { status: 200, value: { object: { sha } } }
        : { status: 404, value: { message: "Not Found" } };
    }
    if (method === "GET" && (match = /^git\/commits\/([a-f0-9]+)$/u.exec(rest))) {
      const sha = match[1]!;
      const tree = await git(slug, "rev-parse", `${sha}^{tree}`);
      return {
        status: 200,
        value: { sha, message: await git(slug, "log", "-1", "--format=%B", sha), tree: { sha: tree } },
      };
    }
    if (method === "GET" && (match = /^git\/trees\/([a-f0-9]+)$/u.exec(rest))) {
      const tree = (await git(slug, "ls-tree", match[1]!))
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [meta, path] = line.split("\t");
          const [mode, type, sha] = meta!.split(" ");
          return { path, mode, type, sha };
        });
      return { status: 200, value: { tree } };
    }
    if (method === "GET" && (match = /^git\/blobs\/([a-f0-9]+)$/u.exec(rest))) {
      const bytes = (
        await run("git", ["-C", bare(slug), "cat-file", "blob", match[1]!], { encoding: "buffer" })
      ).stdout;
      return { status: 200, value: { encoding: "base64", content: bytes.toString("base64") } };
    }
    if (route === "POST git/trees") {
      const entry = (body.tree as { path: string; mode: string; content: string }[])[0]!;
      const baseCommit = await git(slug, "rev-parse", `${body.base_tree as string}`);
      const lines = (await git(slug, "ls-tree", baseCommit)).split("\n").filter(Boolean);
      const entries = new Map(lines.map((line) => [line.split("\t")[1]!, line]));
      const sha = gitInput(slug, entry.content, "hash-object", "-w", "--stdin");
      entries.set(entry.path, `${entry.mode} blob ${sha}\t${entry.path}`);
      return {
        status: 201,
        value: { sha: gitInput(slug, `${[...entries.values()].join("\n")}\n`, "mktree") },
      };
    }
    if (route === "POST git/commits") {
      const sha = await git(
        slug,
        "commit-tree",
        body.tree as string,
        ...(body.parents as string[]).flatMap((parent) => ["-p", parent]),
        "-m",
        body.message as string,
      );
      return { status: 201, value: { sha } };
    }
    if (route === "POST git/refs") {
      const ref = body.ref as string;
      if (await git(slug, "rev-parse", "--verify", ref).catch(() => undefined))
        return { status: 422, value: { message: "Reference already exists" } };
      await git(slug, "update-ref", ref, body.sha as string);
      return { status: 201, value: {} };
    }
    if (method === "PATCH" && (match = /^git\/refs\/(heads\/.+)$/u.exec(rest))) {
      await git(slug, "update-ref", `refs/${match[1]!}`, body.sha as string);
      for (const pull of pulls.get(slug)!)
        if (pull.state === "open" && `heads/${pull.head.ref}` === match[1])
          pull.head.sha = body.sha as string;
      return { status: 200, value: {} };
    }
    if (route === "GET pulls") {
      const wanted = url.searchParams.get("head")?.split(":")[1];
      const list = pulls.get(slug)!.filter((pull) => wanted === undefined || pull.head.ref === wanted);
      return { status: 200, value: list.toReversed() };
    }
    if (route === "POST pulls") {
      const number = pulls.get(slug)!.length + 1;
      const pull: FixturePull = {
        number,
        html_url: `https://forge.invalid/${slug}/pull/${String(number)}`,
        state: "open",
        merged_at: null,
        title: body.title as string,
        body: body.body as string,
        head: {
          ref: body.head as string,
          sha: await refOf(slug, body.head as string),
          repo: { full_name: slug },
        },
        base: { ref: body.base as string },
      };
      pulls.get(slug)!.push(pull);
      return { status: 201, value: pull };
    }
    if (method === "PATCH" && (match = /^pulls\/(\d+)$/u.exec(rest))) {
      const pull = pulls.get(slug)![Number(match[1]) - 1]!;
      if (typeof body.body === "string") pull.body = body.body;
      return { status: 200, value: pull };
    }
    return { status: 404, value: { message: "Not Found" } };
  };

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const method = request.method ?? "GET";
      requests.push({ method, path: url.pathname });
      const text = Buffer.concat(chunks).toString("utf8");
      void handle(method, url, text ? (JSON.parse(text) as Record<string, unknown>) : {})
        .catch((error: unknown) => ({ status: 500, value: { message: String(error) } }))
        .then(({ status, value }) => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(value));
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    requests,
    /** Every request since `mark` that was not a read. */
    writesSince: (mark: number) => requests.slice(mark).filter((request) => request.method !== "GET"),
    pulls: (slug: string) => pulls.get(slug) ?? [],
    async addRepo(slug: string, files: Record<string, FixtureFile>) {
      await mkdir(join(root, slug.split("/")[0]!), { recursive: true });
      await run("git", ["init", "--bare", "--quiet", "--initial-branch=main", bare(slug)]);
      pulls.set(slug, []);
      await git(slug, "update-ref", "refs/heads/main", await commitFiles(slug, undefined, files));
    },
    /** Someone pushing to the default branch, or to a proposal branch. */
    async push(slug: string, branch: string, files: Record<string, FixtureFile>) {
      await git(
        slug,
        "update-ref",
        `refs/heads/${branch}`,
        await commitFiles(slug, await refOf(slug, branch), files),
      );
      for (const pull of pulls.get(slug)!)
        if (pull.state === "open" && pull.head.ref === branch) pull.head.sha = await refOf(slug, branch);
    },
    async read(slug: string, branch: string, path: string) {
      return (await run("git", ["-C", bare(slug), "show", `refs/heads/${branch}:${path}`])).stdout;
    },
    head: (slug: string, branch: string) => refOf(slug, branch),
    /** The repo's own landing rule, played by the fixture: fast-forward main to the proposal. */
    async merge(slug: string, number: number) {
      const pull = pulls.get(slug)![number - 1]!;
      await git(slug, "update-ref", `refs/heads/${pull.base.ref}`, pull.head.sha);
      pull.state = "closed";
      pull.merged_at = "2026-11-05T00:00:00Z";
    },
    close(slug: string, number: number) {
      pulls.get(slug)![number - 1]!.state = "closed";
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    },
  };
}
