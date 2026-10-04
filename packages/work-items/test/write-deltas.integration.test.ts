import { existsSync, readdirSync, renameSync, symlinkSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createFilesBackend } from "../src/backends/files.ts";
import { createGithubBackend, githubRestApi } from "../src/backends/github.ts";
import { createLinearBackend } from "../src/backends/linear.ts";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function fileRepo() {
  const root = await mkdtemp(join(tmpdir(), "work-deltas-"));
  roots.push(root);
  const directory = join(root, "tasks");
  await mkdir(directory);
  const labels = [...Array.from({ length: 25 }, (_, index) => `Role ${String(index)}`), 'Comma, and "quote"'];
  const text = `---\nid: T-1\ntitle: Existing item\nparent: T-0\nlabels: ${JSON.stringify(labels)}\ndepends_on: T-2\n---\n\n**Owner:** previous\n\nOwner-written notes.\n`;
  const path = join(directory, "T-1-existing.md");
  await writeFile(path, text);
  return { root, directory, path, labels, text };
}

it("publishes file deltas once from complete metadata and checks the fence after temporary IO", async () => {
  const f = await fileRepo();
  const events: string[] = [];
  const backend = createFilesBackend({
    root: f.root,
    directory: "tasks",
    kind: "markdown",
    scopedWrites: true,
    beforeWrite: () => {
      expect(readdirSync(f.directory).some((name) => name.endsWith(".tmp"))).toBe(true);
      expect(existsSync(f.path)).toBe(true);
      events.push("fence");
    },
    onDispatch: () => events.push("dispatch"),
    effectConfirmed: () => events.push("confirmed"),
  });
  expect((await backend.get("T-1"))?.labels).toHaveLength(20);
  const updated = await backend.update("T-1", {
    owner: "new-worker",
    addLabels: ["designer", "ROLE 24"],
    removeLabels: ["role 1"],
    addDependsOn: ["T-3", "T-2"],
  });
  expect(updated).toMatchObject({ owner: "new-worker", parent: "T-0", dependsOn: ["T-2", "T-3"] });
  const text = await readFile(f.path, "utf8");
  const rawLabels = JSON.parse(/^labels: (.+)$/mu.exec(text)![1]!) as string[];
  expect(rawLabels).toEqual([...f.labels.filter((name) => name !== "Role 1"), "designer"]);
  expect(text).toContain("Owner-written notes.");
  expect(text).not.toContain("**Owner:** previous");
  expect(events).toEqual(["fence", "dispatch", "confirmed"]);
  expect((await readdir(f.directory)).some((name) => name.endsWith(".tmp"))).toBe(false);
  await backend.update("T-1", { owner: null });
  expect((await backend.get("T-1"))?.owner).toBeUndefined();
});

it("refuses the final file fence without publishing and cleans its prepared temporary file", async () => {
  const f = await fileRepo();
  const events: string[] = [];
  const backend = createFilesBackend({
    root: f.root,
    directory: "tasks",
    kind: "markdown",
    scopedWrites: true,
    beforeWrite: () => {
      throw new Error("Device revoked");
    },
    onDispatch: () => events.push("dispatch"),
    effectConfirmed: () => events.push("confirmed"),
  });
  await expect(backend.update("T-1", { owner: "other" })).rejects.toThrow("Device revoked");
  expect(await readFile(f.path, "utf8")).toBe(f.text);
  expect(await readdir(f.directory)).toEqual(["T-1-existing.md"]);
  expect(events).toEqual([]);
});

it("rejects scoped symlink directories, files and a target replaced during the final fence", async () => {
  const f = await fileRepo();
  const outside = await mkdtemp(join(tmpdir(), "work-outside-"));
  roots.push(outside);
  await writeFile(join(outside, "T-1-existing.md"), f.text);
  await symlink(outside, join(f.root, "linked"));
  await expect(
    createFilesBackend({ root: f.root, directory: "linked", kind: "markdown", scopedWrites: true }).update(
      "T-1",
      { owner: "other" },
    ),
  ).rejects.toMatchObject({ code: "work_item_out_of_scope" });
  await symlink(join(outside, "T-1-existing.md"), join(f.directory, "T-9-link.md"));
  await expect(
    createFilesBackend({ root: f.root, directory: "tasks", kind: "markdown", scopedWrites: true }).get("T-1"),
  ).rejects.toMatchObject({ code: "work_item_out_of_scope" });
  await rm(join(f.directory, "T-9-link.md"));
  const backend = createFilesBackend({
    root: f.root,
    directory: "tasks",
    kind: "markdown",
    scopedWrites: true,
    beforeWrite: () => {
      renameSync(f.path, `${f.path}.original`);
      symlinkSync(join(outside, "T-1-existing.md"), f.path);
    },
  });
  await expect(backend.update("T-1", { owner: "other" })).rejects.toMatchObject({
    code: "work_item_out_of_scope",
  });
  expect(await readFile(join(outside, "T-1-existing.md"), "utf8")).toBe(f.text);
  expect((await readdir(f.directory)).some((name) => name.endsWith(".tmp"))).toBe(false);
});

async function githubFixture() {
  const labels = Array.from({ length: 25 }, (_, index) => `role-${String(index)}`);
  const issue: Record<string, unknown> = {
    number: 42,
    title: "Existing",
    body: "**Owner:** previous\n\n**Depends on:** #40\n\nOwner notes.\n",
    state: "open",
    html_url: "https://github.com/o/r/issues/42",
    labels,
  };
  const events: string[] = [];
  const mutations: Record<string, unknown>[] = [];
  let parentStatus = 200;
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.endsWith("/parent")) {
      events.push("parent-read");
      response.statusCode = parentStatus;
      response.end(JSON.stringify({ number: 2, repository_url: "https://api.github.com/repos/o/r" }));
      return;
    }
    if (request.method === "PATCH") {
      events.push("provider-write");
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const patch = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      mutations.push(patch);
      Object.assign(issue, patch);
    } else events.push("raw-read");
    response.end(JSON.stringify(issue));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture port");
  const api = githubRestApi({ token: "fixture-token", baseUrl: `http://127.0.0.1:${String(address.port)}` });
  return {
    labels,
    issue,
    events,
    mutations,
    api,
    failParent: () => {
      parentStatus = 503;
    },
  };
}

it("sends one GitHub HTTP mutation with full labels/dependencies and confirms before parent reads", async () => {
  const f = await githubFixture();
  const backend = createGithubBackend({
    repo: "o/r",
    api: f.api,
    scopedWrites: true,
    beforeWrite: () => f.events.push("fence"),
    onDispatch: () => f.events.push("dispatch"),
    effectConfirmed: () => f.events.push("confirmed"),
  });
  const updated = await backend.update("#42", {
    owner: "new-worker",
    addLabels: ["Designer", "ROLE-24"],
    removeLabels: ["role-1"],
    addDependsOn: ["#41", "#40"],
  });
  expect(updated).toMatchObject({ owner: "new-worker", parent: "#2", dependsOn: ["#40", "#41"] });
  expect(f.mutations).toHaveLength(1);
  expect(f.mutations[0]?.labels).toEqual([...f.labels.filter((name) => name !== "role-1"), "Designer"]);
  expect(f.mutations[0]).not.toHaveProperty("assignees");
  expect(f.issue.body).toContain("Owner notes.");
  expect(f.events).toEqual(["raw-read", "fence", "dispatch", "provider-write", "confirmed", "parent-read"]);
  f.failParent();
  f.events.length = 0;
  await expect(backend.update("#42", { owner: null })).rejects.toThrow("HTTP 503");
  expect(f.events).toEqual(["raw-read", "fence", "dispatch", "provider-write", "confirmed", "parent-read"]);
});

it("refuses GitHub's final fence and scoped reserved labels before any HTTP write", async () => {
  const f = await githubFixture();
  const scoped = createGithubBackend({ repo: "o/r", api: f.api, scopedWrites: true });
  for (const name of ["STATUS: IN PROGRESS", "doing", "wip", "in review", "in-progress"])
    await expect(scoped.update("#42", { addLabels: [name] })).rejects.toThrow("status labels");
  const revoked = createGithubBackend({
    repo: "o/r",
    api: f.api,
    beforeWrite: () => {
      throw new Error("Device revoked");
    },
  });
  await expect(revoked.update("#42", { addLabels: ["designer"] })).rejects.toThrow("Device revoked");
  expect(f.mutations).toEqual([]);
});

it("composes scoped Linear writes with board/role filtering and uploaded evidence over HTTP", async () => {
  // Start with the observed connected MCP issue shape; HTTP replays its native
  // tool-result boundary without a live tracker write or mocked fetch.
  const observed = JSON.parse(
    await readFile(new URL("./fixtures/parent/linear-issue.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  const teamId = "d53265da-b742-43c3-9a13-7cac6506234e";
  const projectId = "bdfa8c5a-933d-4f59-abf7-db42f81e45d1";
  const labels = [...Array.from({ length: 25 }, (_, index) => `Role ${String(index)}`), "Board", "Builder"];
  const upload = "![original](https://uploads.linear.app/fixture/original.png)";
  const issue: Record<string, unknown> = {
    ...observed,
    teamId,
    projectId,
    labels,
    description: `**Owner:** previous\n\nOwner notes.\n\n## Evidence\n\n${upload}\n`,
  };
  const events: string[] = [];
  const reads: Record<string, unknown>[] = [];
  const mutations: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const { tool, args } = JSON.parse(Buffer.concat(chunks).toString()) as {
      tool: string;
      args: Record<string, unknown>;
    };
    events.push(tool);
    response.setHeader("content-type", "application/json");
    if (tool === "get_team") response.end(JSON.stringify({ id: teamId, name: "Vuhlp" }));
    else if (tool === "get_project")
      response.end(JSON.stringify({ id: "P-VUH-17", uuid: projectId, name: "Clankie" }));
    else if (tool === "get_issue") response.end(JSON.stringify(issue));
    else if (tool === "list_issues") {
      reads.push(args);
      const wanted = String(args.label ?? "")
        .trim()
        .toLowerCase();
      const matches = (issue.labels as string[]).some((name) => name.toLowerCase() === wanted);
      response.end(JSON.stringify({ issues: matches ? [issue] : [], hasNextPage: false }));
    } else if (tool === "save_issue") {
      mutations.push(args);
      if (Array.isArray(args.patch)) {
        for (const op of args.patch as {
          op: string;
          old_string?: string;
          new_string?: string;
          text?: string;
        }[]) {
          const before = String(issue.description);
          if (op.op === "replace") {
            if (op.old_string === undefined || !before.includes(op.old_string)) {
              response.statusCode = 422;
              response.end(JSON.stringify({ error: "Missing exact patch target" }));
              return;
            }
            issue.description = before.replace(op.old_string, op.new_string ?? "");
          } else issue.description = before + (op.text ?? "");
        }
      } else if (typeof args.description === "string") issue.description = args.description;
      if (Array.isArray(args.labels)) issue.labels = args.labels;
      response.end(JSON.stringify(issue));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "Unexpected tool" }));
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture port");
  const backend = createLinearBackend({
    team: "VUH",
    project: "Clankie",
    label: "Board",
    scopedWrites: true,
    call: async (tool, args) => {
      const response = await fetch(`http://127.0.0.1:${String(address.port)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tool, args }),
      });
      if (!response.ok) throw new Error(`Fixture HTTP ${String(response.status)}`);
      return response.json();
    },
    beforeWrite: () => events.push("fence"),
    onDispatch: () => events.push("dispatch"),
    effectConfirmed: () => events.push("confirmed"),
  });
  const [listed] = await backend.list({ label: " BUILDER " });
  expect(reads[0]).toMatchObject({ team: "VUH", project: "Clankie", label: "Board" });
  expect(reads[0]?.fields).toEqual(expect.arrayContaining(["labels", "parentId"]));
  expect(listed?.parent).toBe("VUH-1588");
  expect(listed?.labels).toHaveLength(20);
  expect(listed?.labels).not.toContain("Builder");
  events.length = 0;
  const updated = await backend.update("VUH-1593", {
    owner: "new-worker",
    addLabels: ["Designer"],
    removeLabels: ["role 1"],
  });
  expect(updated).toMatchObject({ owner: "new-worker", parent: "VUH-1588" });
  expect(mutations[0]?.labels).toEqual([...labels.filter((name) => name !== "Role 1"), "Designer"]);
  expect(mutations[0]).not.toHaveProperty("assignee");
  expect(events[0]).toBe("get_issue");
  expect(events.slice(-5)).toEqual(["fence", "dispatch", "save_issue", "confirmed", "get_issue"]);
  events.length = 0;
  await backend.attach("VUH-1593", {
    kind: "link",
    url: "https://example.com/proof",
    caption: "new evidence",
  });
  expect(mutations[1]?.patch).toEqual([
    {
      op: "replace",
      old_string: "## Evidence",
      new_string: "## Evidence\n\n- link: [new evidence](https://example.com/proof)",
    },
  ]);
  expect(issue.description).toContain(upload);
  expect(issue.description).toContain("Owner notes.");
  expect(events.slice(-5)).toEqual(["fence", "dispatch", "save_issue", "confirmed", "get_issue"]);
  // The saved label filters a board; it does not revoke direct item access or
  // change canonical team/project write authority when a native label changes.
  issue.labels = (issue.labels as string[]).filter((name) => name !== "Board");
  expect(await backend.list()).toEqual([]);
  expect((await backend.get("VUH-1593"))?.owner).toBe("new-worker");
  expect((await backend.update("VUH-1593", { owner: null })).owner).toBeUndefined();
  expect(issue.description).toContain(upload);
});
