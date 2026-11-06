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
  updated_at: string;
  title: string;
  body: string;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string };
}

/** `unknown` answers with neither field, as a token too narrow to see them would. */
export type FixtureVisibility = "public" | "private" | "internal" | "unknown";
const VISIBILITY_FIELDS = {
  public: { private: false, visibility: "public" },
  private: { private: true, visibility: "private" },
  internal: { private: true, visibility: "internal" },
  unknown: {},
} as const;

export interface FixtureFile {
  readonly content: string | Buffer;
  /** Git mode; `120000` makes `content` a symlink target. */
  readonly mode?: string;
}

/**
 * GitHub's git-data and pull endpoints over real bare repositories, on 127.0.0.1 only. There
 * is no merge endpoint and no issues endpoint: a client that reaches for either gets a 404
 * recorded in `requests`, and merging is the fixture's own `merge`, standing in for a person.
 *
 * It keeps GitHub's rules a client can break: the repo's own default branch, a 403 on any write
 * to an archived repo, a 422 on a non-fast-forward ref update without `force` and on a pull to a
 * missing base, the new `full_name` after a rename, pulls sorted by when they were last updated
 * and paged with a `Link` header, and a deleted head closing its open pull. GraphQL's `updateRefs`
 * keeps its `beforeOid`: a ref that no longer points there is refused, with a 200 and `errors`.
 * It is recorded as `POST /graphql:updateRefs:<repo>:<ref>:<update|delete>`, so a filter on the
 * repo still sees it.
 */
export async function startLoopbackForge() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "loopback-forge-")));
  const pulls = new Map<string, FixturePull[]>();
  const visibility = new Map<string, FixtureVisibility>();
  const defaultBranches = new Map<string, string>();
  const archived = new Set<string>();
  const undeletable = new Set<string>();
  const fullNames = new Map<string, string>();
  /** Repos whose root trees GitHub lists only in part, leaving out every guide. */
  const truncated = new Set<string>();
  const NO_REF = "0000000000000000000000000000000000000000";
  let clock = Date.parse("2026-11-05T00:00:00Z");
  const tick = () => new Date((clock += 1000)).toISOString();
  const requests: { method: string; path: string }[] = [];
  /** A hook run as each request arrives, before it is answered: someone acting mid-pass. */
  let onRequest: ((method: string, path: string) => Promise<void> | void) | undefined;
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

  const closeOpenPulls = (slug: string, ref: string) => {
    for (const pull of pulls.get(slug)!)
      if (
        pull.state === "open" &&
        `heads/${pull.head.ref}` === ref &&
        pull.head.repo?.full_name === (fullNames.get(slug) ?? slug)
      )
        pull.state = "closed";
  };
  const graphql = async (body: Record<string, unknown>) => {
    const variables = body.variables as {
      repositoryId: string;
      refUpdates: { name: string; beforeOid?: string; afterOid: string; force?: boolean }[];
    };
    if (!/^\s*mutation\b[^{]*\{\s*updateRefs\(/u.test(body.query as string))
      return { status: 200, value: { errors: [{ message: "Fixture serves only updateRefs" }] } };
    const slug = variables.repositoryId.replace(/^R_/u, "");
    const refused = (message: string) => ({ status: 200, value: { data: null, errors: [{ message }] } });
    if (!pulls.has(slug)) return refused("Could not resolve to a node");
    if (archived.has(slug)) return refused("Repository was archived so is read-only.");
    const [update] = variables.refUpdates;
    const ref = update!.name.replace(/^refs\//u, "");
    const now = await git(slug, "rev-parse", "--verify", `refs/${ref}`).catch(() => NO_REF);
    if (update!.beforeOid !== undefined && update!.beforeOid !== now)
      return refused(`A ref was updated by someone else: ${update!.name}`);
    if (update!.afterOid === NO_REF) {
      if (undeletable.has(`${slug}:${ref}`)) return refused("Cannot delete this protected branch");
      if (now === NO_REF) return refused("Reference does not exist");
      await git(slug, "update-ref", "-d", `refs/${ref}`);
      closeOpenPulls(slug, ref);
    } else {
      const fastForward =
        now === NO_REF ||
        (await git(slug, "merge-base", "--is-ancestor", now, update!.afterOid).then(
          () => true,
          () => false,
        ));
      if (!fastForward && update!.force !== true) return refused("Update is not a fast forward");
      await git(slug, "update-ref", `refs/${ref}`, update!.afterOid);
      for (const pull of pulls.get(slug)!)
        if (pull.state === "open" && `heads/${pull.head.ref}` === ref) {
          pull.head.sha = update!.afterOid;
          pull.updated_at = tick();
        }
    }
    return { status: 200, value: { data: { updateRefs: { clientMutationId: null } } } };
  };

  const handle = async (method: string, url: URL, body: Record<string, unknown>) => {
    if (method === "POST" && url.pathname === "/graphql") return graphql(body);
    const parts = /^\/repos\/([^/]+\/[^/]+)(?:\/(.*))?$/u.exec(url.pathname);
    if (!parts) return { status: 404, value: { message: "Not Found" } };
    const slug = parts[1]!;
    const rest = parts[2] ?? "";
    if (!pulls.has(slug)) return { status: 404, value: { message: "Not Found" } };
    const route = `${method} ${rest}`;
    if (method !== "GET" && archived.has(slug))
      return { status: 403, value: { message: "Repository was archived so is read-only." } };
    if (route === "GET ")
      return {
        status: 200,
        value: {
          node_id: `R_${slug}`,
          full_name: fullNames.get(slug) ?? slug,
          default_branch: defaultBranches.get(slug),
          archived: archived.has(slug),
          ...VISIBILITY_FIELDS[visibility.get(slug) ?? "public"],
        },
      };
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
        value: {
          sha,
          message: await git(slug, "log", "-1", "--format=%B", sha),
          tree: { sha: tree },
          parents: (await git(slug, "log", "-1", "--format=%P", sha))
            .split(" ")
            .filter(Boolean)
            .map((parent) => ({ sha: parent })),
        },
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
      if (!truncated.has(slug)) return { status: 200, value: { tree, truncated: false } };
      const shown = tree.filter((entry) => !["CLAUDE.md", "AGENTS.md"].includes(entry.path!));
      return { status: 200, value: { tree: shown, truncated: true } };
    }
    if (method === "GET" && (match = /^contents\/([^/]+)$/u.exec(rest))) {
      const path = decodeURIComponent(match[1]!);
      const line = await git(slug, "ls-tree", url.searchParams.get("ref") ?? "HEAD", "--", path);
      if (!line) return { status: 404, value: { message: "Not Found" } };
      const [mode, type, sha] = line.split("\t")[0]!.split(" ");
      if (type === "tree") return { status: 200, value: [] };
      const kind = mode === "120000" ? "symlink" : type === "commit" ? "submodule" : "file";
      return { status: 200, value: { type: kind, sha, path } };
    }
    if (method === "GET" && (match = /^compare\/(.+)\.\.\.([a-f0-9]+)$/u.exec(rest))) {
      const base = await git(
        slug,
        "rev-parse",
        "--verify",
        `${decodeURIComponent(match[1]!)}^{commit}`,
      ).catch(() => undefined);
      const head = match[2]!;
      if (!base) return { status: 404, value: { message: "Not Found" } };
      const ancestor = (a: string, b: string) =>
        git(slug, "merge-base", "--is-ancestor", a, b).then(
          () => true,
          () => false,
        );
      const status =
        base === head
          ? "identical"
          : (await ancestor(head, base))
            ? "behind"
            : (await ancestor(base, head))
              ? "ahead"
              : "diverged";
      return { status: 200, value: { status } };
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
      const tip = await git(slug, "rev-parse", `refs/${match[1]!}`);
      const fastForward = await git(slug, "merge-base", "--is-ancestor", tip, body.sha as string).then(
        () => true,
        () => false,
      );
      if (!fastForward && body.force !== true)
        return { status: 422, value: { message: "Update is not a fast forward" } };
      await git(slug, "update-ref", `refs/${match[1]!}`, body.sha as string);
      for (const pull of pulls.get(slug)!)
        if (pull.state === "open" && `heads/${pull.head.ref}` === match[1]) {
          pull.head.sha = body.sha as string;
          pull.updated_at = tick();
        }
      return { status: 200, value: {} };
    }
    if (method === "DELETE" && (match = /^git\/refs\/(heads\/.+)$/u.exec(rest))) {
      if (undeletable.has(`${slug}:${match[1]!}`))
        return { status: 422, value: { message: "Cannot delete this protected branch" } };
      if ((await git(slug, "rev-parse", "--verify", `refs/${match[1]!}`).catch(() => "")) === "")
        return { status: 422, value: { message: "Reference does not exist" } };
      await git(slug, "update-ref", "-d", `refs/${match[1]!}`);
      closeOpenPulls(slug, match[1]!);
      return { status: 204, value: undefined };
    }
    if (route === "GET pulls") {
      const wanted = url.searchParams.get("head")?.split(":")[1];
      const page = Number(url.searchParams.get("page") ?? "1");
      const size = Number(url.searchParams.get("per_page") ?? "30");
      const list = pulls
        .get(slug)!
        .filter((pull) => wanted === undefined || pull.head.ref === wanted)
        .toSorted((a, b) => b.updated_at.localeCompare(a.updated_at) || b.number - a.number);
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      return {
        status: 200,
        value: list.slice((page - 1) * size, page * size),
        ...(page * size < list.length ? { link: `<${next.href}>; rel="next"` } : {}),
      };
    }
    if (route === "POST pulls") {
      if (!(await refOf(slug, body.base as string).catch(() => undefined)))
        return { status: 422, value: { message: "Validation Failed: base" } };
      const number = pulls.get(slug)!.length + 1;
      const pull: FixturePull = {
        number,
        html_url: `https://forge.invalid/${slug}/pull/${String(number)}`,
        state: "open",
        merged_at: null,
        updated_at: tick(),
        title: body.title as string,
        body: body.body as string,
        head: {
          ref: body.head as string,
          sha: await refOf(slug, body.head as string),
          repo: { full_name: fullNames.get(slug) ?? slug },
        },
        base: { ref: body.base as string },
      };
      pulls.get(slug)!.push(pull);
      return { status: 201, value: pull };
    }
    if (method === "PATCH" && (match = /^pulls\/(\d+)$/u.exec(rest))) {
      const pull = pulls.get(slug)![Number(match[1]) - 1]!;
      if (typeof body.body === "string") pull.body = body.body;
      if (body.state === "closed") pull.state = "closed";
      pull.updated_at = tick();
      return { status: 200, value: pull };
    }
    return { status: 404, value: { message: "Not Found" } };
  };

  let port = 0;
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url ?? "/", `http://127.0.0.1:${String(port)}`);
      const method = request.method ?? "GET";
      const text = Buffer.concat(chunks).toString("utf8");
      const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
      const update = (body.variables as { refUpdates?: { name: string; afterOid: string }[] } | undefined)
        ?.refUpdates?.[0];
      const path =
        url.pathname === "/graphql" && update
          ? `/graphql:updateRefs:${String((body.variables as { repositoryId: string }).repositoryId).replace(/^R_/u, "")}:${update.name}:${update.afterOid === NO_REF ? "delete" : "update"}`
          : url.pathname;
      requests.push({ method, path });
      void Promise.resolve(onRequest?.(method, path))
        .then(() => handle(method, url, body))
        .catch((error: unknown) => ({ status: 500, value: { message: String(error) } }))
        .then((reply: { status: number; value: unknown; link?: string }) => {
          response.writeHead(reply.status, {
            "content-type": "application/json",
            ...(reply.link ? { link: reply.link } : {}),
          });
          response.end(reply.value === undefined ? undefined : JSON.stringify(reply.value));
        });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    requests,
    /** Run `hook` as each later request arrives, before it is answered. */
    onRequest(hook: typeof onRequest) {
      onRequest = hook;
    },
    /** GitHub listing this repo's root trees only in part, as it does past its size limit. */
    truncateTrees: (slug: string) => truncated.add(slug),
    /**
     * A commit on `branch` with `message` and `parent` (the tip by default), as someone amending
     * or stacking on a proposal would push it.
     */
    async commitAs(
      slug: string,
      branch: string,
      files: Record<string, FixtureFile>,
      message: string,
      parent?: string,
    ) {
      const base = parent ?? (await refOf(slug, branch));
      const sha = await commitFiles(slug, base, files);
      const tree = await git(slug, "rev-parse", `${sha}^{tree}`);
      const commit = await git(slug, "commit-tree", tree, "-p", base, "-m", message);
      await git(slug, "update-ref", `refs/heads/${branch}`, commit);
      for (const pull of pulls.get(slug)!)
        if (pull.state === "open" && pull.head.ref === branch) pull.head.sha = commit;
      return commit;
    },
    message: (slug: string, sha: string) => git(slug, "log", "-1", "--format=%B", sha),
    /** Every request since `mark` that was not a read. */
    writesSince: (mark: number) => requests.slice(mark).filter((request) => request.method !== "GET"),
    pulls: (slug: string) => pulls.get(slug) ?? [],
    async addRepo(
      slug: string,
      files: Record<string, FixtureFile>,
      seen: FixtureVisibility = "public",
      defaultBranch = "main",
    ) {
      visibility.set(slug, seen);
      defaultBranches.set(slug, defaultBranch);
      await mkdir(join(root, slug.split("/")[0]!), { recursive: true });
      await run("git", ["init", "--bare", "--quiet", `--initial-branch=${defaultBranch}`, bare(slug)]);
      pulls.set(slug, []);
      await git(slug, "update-ref", `refs/heads/${defaultBranch}`, await commitFiles(slug, undefined, files));
    },
    /** The owner flipping a repo's visibility on the forge. */
    setVisibility: (slug: string, seen: FixtureVisibility) => visibility.set(slug, seen),
    archive: (slug: string) => archived.add(slug),
    /** A branch rule that refuses deletion, until `allowDelete`. */
    protectBranch: (slug: string, branch: string) => undeletable.add(`${slug}:heads/${branch}`),
    allowDelete: (slug: string, branch: string) => undeletable.delete(`${slug}:heads/${branch}`),
    /** Someone deleting a branch, or the repo's delete-on-merge setting doing it. */
    deleteBranch: (slug: string, branch: string) => git(slug, "update-ref", "-d", `refs/heads/${branch}`),
    /** The old name keeps answering, as GitHub's redirect does, with the new `full_name`. */
    rename(slug: string, fullName: string) {
      fullNames.set(slug, fullName);
      for (const pull of pulls.get(slug)!) pull.head.repo = { full_name: fullName };
    },
    /** A comment: nothing but `updated_at` moves, which is what GitHub sorts on. */
    comment(slug: string, number: number) {
      pulls.get(slug)![number - 1]!.updated_at = tick();
    },
    /** A pull from `headRepo`, with the commit in this repo's object store as a fork network shares it. */
    async forkPull(slug: string, headRepo: string | null, ref: string) {
      const sha = await commitFiles(slug, await refOf(slug, defaultBranches.get(slug)!), {
        "FORK.md": { content: "From a fork.\n" },
      });
      const number = pulls.get(slug)!.length + 1;
      pulls.get(slug)!.push({
        number,
        html_url: `https://forge.invalid/${slug}/pull/${String(number)}`,
        state: "open",
        merged_at: null,
        updated_at: tick(),
        title: "From a fork",
        body: "",
        head: { ref, sha, repo: headRepo === null ? null : { full_name: headRepo } },
        base: { ref: defaultBranches.get(slug)! },
      });
      return number;
    },
    /** Merged proposals from long ago, enough to push an older pull onto a later page. */
    async seedMergedPulls(slug: string, count: number, ref: string) {
      const sha = await refOf(slug, defaultBranches.get(slug)!);
      for (let index = 0; index < count; index += 1) {
        const number = pulls.get(slug)!.length + 1;
        pulls.get(slug)!.push({
          number,
          html_url: `https://forge.invalid/${slug}/pull/${String(number)}`,
          state: "closed",
          merged_at: "2026-01-01T00:00:00Z",
          updated_at: tick(),
          title: "Seeded",
          body: "",
          head: { ref, sha, repo: { full_name: fullNames.get(slug) ?? slug } },
          base: { ref: defaultBranches.get(slug)! },
        });
      }
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
      pull.updated_at = tick();
    },
    close(slug: string, number: number) {
      const pull = pulls.get(slug)![number - 1]!;
      pull.state = "closed";
      pull.updated_at = tick();
    },
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    },
  };
}
