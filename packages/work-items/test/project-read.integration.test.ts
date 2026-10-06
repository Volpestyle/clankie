import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { WorkConventionSchema, WorkProjectFactsSchema } from "@clankie/protocol";
import { backendFor, githubRestApi, readProjectWork } from "../src/index.ts";

const exec = promisify(execFile);
it("reads actual local version tags and HTTP GitHub facts without inventing goals or release membership", async () => {
  const root = await mkdtemp(join(tmpdir(), "world-facts-"));
  const requests: string[] = [];
  let labels: string[] = [];
  const issue = () => ({
    number: 42,
    title: "Ship this",
    state: "open",
    body: "",
    labels,
    milestone: { number: 7, title: "Next ship" },
    html_url: "https://github.com/owner/repo/issues/42",
  });
  const server = createServer(async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/parent")) {
      response.writeHead(404);
      response.end("{}");
      return;
    }
    if (request.method === "PATCH") {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      labels = (JSON.parse(body) as { labels: string[] }).labels;
    }
    const value = request.url?.includes("milestones?")
      ? [{ number: 7, title: "Next ship", due_on: "2026-11-01T00:00:00Z" }]
      : request.url?.includes("releases?")
        ? [
            {
              tag_name: "v1.0",
              draft: false,
              published_at: "2026-10-05T12:00:00Z",
              html_url: "https://github.com/owner/repo/releases/tag/v1.0",
            },
            { tag_name: "v9.0", draft: true, published_at: null },
          ]
        : request.url?.includes("issues?")
          ? [issue()]
          : issue();
    response.end(JSON.stringify(value));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const git = (args: string[]) => exec("git", args, { cwd: root });
    await git(["init", "-q"]);
    await git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "--allow-empty",
      "-qm",
      "Initial",
    ]);
    await git(["tag", "v1.0"]);
    await git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "tag",
      "-am",
      "Version tag",
      "v2.0",
    ]);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing HTTP address");
    const github = githubRestApi({ token: "fixture", baseUrl: `http://127.0.0.1:${address.port}` });
    const run = async (command: string, args: readonly string[], cwd: string) =>
      (await exec(command, [...args], { cwd })).stdout;
    const convention = WorkConventionSchema.parse({
      schemaVersion: 1,
      backend: "github",
      github: { repo: "owner/repo" },
      releases: { source: "both", lane: "macos" },
      decidedBy: "owner",
      decidedAt: "2026-10-05",
    });
    const facts = WorkProjectFactsSchema.parse(await readProjectWork(root, convention, { github, run }));
    expect(facts).toMatchObject({
      releaseSource: "both",
      planned: [{ id: "7", name: "Next ship", itemIds: ["#42"] }],
      shipped: expect.arrayContaining([
        {
          version: "v1.0",
          lane: "macos",
          date: "2026-10-05T12:00:00Z",
          dateKind: "published",
          itemIds: [],
          location: "https://github.com/owner/repo/releases/tag/v1.0",
        },
        expect.objectContaining({ version: "v2.0", dateKind: "tag", lane: "macos" }),
      ]),
      goals: [],
      unavailable: [],
    });
    expect(facts.shipped).toHaveLength(2);
    const partial = await readProjectWork(root, convention, { github });
    expect(partial.shipped).toMatchObject([{ version: "v1.0", dateKind: "published" }]);
    expect(partial.unavailable).toMatchObject([{ read: "shipped" }]);
    const backend = backendFor(root, convention, { github });
    expect(await backend.update("#42", { status: "backlog" })).toMatchObject({
      status: "backlog",
      milestone: { id: "7", name: "Next ship" },
    });
    expect(labels).toContain("status: backlog");
    expect(await backend.update("#42", { status: "todo" })).toMatchObject({ status: "todo" });
    const count = requests.length;
    const tagsOnly = await readProjectWork(
      root,
      { ...convention, releases: { source: "tags", lane: "mobile" } },
      { github, run },
    );
    expect(tagsOnly.planned).toEqual([]);
    expect(requests.slice(count)).toEqual(["GET /repos/owner/repo/releases?per_page=100"]);
    await mkdir(join(root, "tasks"));
    await writeFile(
      join(root, "tasks/T-1.md"),
      "---\nid: T-1\ntitle: Later work\nstatus: backlog\npriority: 2\nmilestone_id: launch\nmilestone_name: Launch\n---\n",
    );
    const markdown = { ...convention, backend: "markdown" as const, directory: "tasks" };
    const files = backendFor(root, markdown, {});
    expect(await files.get("T-1")).toMatchObject({
      status: "backlog",
      priority: 2,
      milestone: { id: "launch", name: "Launch" },
    });
    expect(await files.update("T-1", { status: "todo" })).toMatchObject({ status: "todo" });
    const local = await readProjectWork(root, markdown, { run });
    expect(local.goals).toEqual([]);
    expect(local.planned).toEqual([]);
    expect(local.unavailable).toEqual([
      { read: "planned", message: "Planned milestones are unavailable for this tracker or project." },
    ]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});
