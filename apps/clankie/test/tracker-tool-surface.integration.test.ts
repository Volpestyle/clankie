import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { FileCredentialStore } from "@clankie/credential-broker";
import { SettingsStore } from "@clankie/settings";
import { createLocalTracker } from "@clankie/work-items";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createMcpHost } from "../src/mcp-host.ts";
import { WorkerMcp } from "../src/worker-mcp.ts";
import { createWorkItemsService, type WorkItemsServiceOptions } from "../src/work-items.ts";
import { githubConnectionToken } from "../src/accounts.ts";
import { workRequest } from "../../tui/src/command/work.ts";

/** Real fleet HTTP tools, host, settings, credentials and durable local storage. */
async function surface(root: string, github: Pick<WorkItemsServiceOptions, "gh" | "githubApiBase"> = {}) {
  const settings = new SettingsStore(join(root, "settings.json"));
  const credentials = new FileCredentialStore(join(root, "credentials.json"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  let workItems!: ReturnType<typeof createWorkItemsService>;
  const local = createLocalTracker({ directory: join(root, "tracker") });
  const host = createMcpHost({
    credentials,
    settings,
    localTracker: local,
    // A later connection test can only address this unreachable local endpoint.
    curated: [
      {
        id: "linear",
        credential: "linear",
        transport: "http",
        url: "http://127.0.0.1:1/mcp",
        args: [],
        lane: "everywhere",
        initialTools: [],
        enabled: true,
      },
    ],
    trackerForRepo: ({ name, args, repo, local, ...publication }) =>
      workItems.callTracker(name, args, { repo, local, ...publication }),
    trackerRepoForCall: (name, args) => workItems.resolveTrackerRepo(name, args),
    logger: { info() {}, warn() {} },
  });
  workItems = createWorkItemsService({
    stateDirectory: join(root, "work"),
    globalTrackerDirectory: join(root, "tracker"),
    workspace: () => repo,
    mcpHost: host,
    githubToken: () => githubConnectionToken(credentials),
    ...github,
  });
  const worker = new WorkerMcp({
    directory: join(root, "grants"),
    credentials,
    host,
    fleetTools: async () => (await settings.load()).fleet.tools,
    fleetToolsSnapshot: async () => {
      const snapshot = await settings.loadFenced();
      return { tools: snapshot.settings.fleet.tools, assertCurrent: snapshot.assertCurrent };
    },
  });
  // The tracker does not depend on a model run. Other captain operations stay idle.
  const app = await createClankieApp({
    captain: createStubCaptain(),
    workerMcp: worker,
    workItems,
    fleetLinks: {
      identity: () => undefined,
      authenticate: (token) => (token === "local-fleet-test" ? "test-fleet" : undefined),
    },
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer tracker-owner"
        ? { operatorId: "tracker-owner" }
        : undefined,
  });
  let sequence = 0;
  let session: string | undefined;
  async function rpc(method: string, params: unknown) {
    return app.app.request("/v1/fleet/mcp", {
      method: "POST",
      headers: {
        authorization: "Bearer local-fleet-test",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++sequence, method, params }),
    });
  }
  const initialized = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "tracker-surface-integration", version: "1" },
  });
  expect(initialized.status).toBe(200);
  session = initialized.headers.get("mcp-session-id")!;
  async function tool(name: string, args: unknown) {
    const response = await rpc("tools/call", { name, arguments: args });
    expect(response.status).toBe(200);
    return (await response.json()).result as {
      content: { type: string; text: string }[];
      isError?: boolean;
    };
  }
  async function call(name: string, args: Record<string, unknown>) {
    const result = await tool("clankie_call", { name, arguments: args });
    expect(result.isError, result.content[0]?.text).not.toBe(true);
    const receipt = JSON.parse(result.content[0]!.text);
    expect(receipt).toMatchObject({ outcome: "ok", receiptId: expect.any(String), isError: false });
    return JSON.parse(receipt.content);
  }
  return {
    settings,
    host,
    credentials,
    repo,
    workItems,
    work: async (args: string[]) => {
      const response = await app.app.request("/v1/work", {
        method: "POST",
        headers: { authorization: "Bearer tracker-owner", "content-type": "application/json" },
        body: JSON.stringify(workRequest(args, "workspace")),
      });
      const result = await response.json();
      expect(response.status, JSON.stringify(result)).toBe(200);
      return result;
    },
    tool,
    call,
    close: async () => {
      app.close();
      await worker.close();
      await host.close();
    },
  };
}

it("runs unchanged Linear issue/project/comment shapes through the offline fleet tools and persists them", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-tracker-surface-"));
  let f = await surface(root);
  try {
    const names = [
      "linear_get_issue",
      "linear_list_issues",
      "linear_save_issue",
      "linear_list_comments",
      "linear_save_comment",
      "linear_get_project",
      "linear_list_projects",
      "linear_save_project",
      "linear_get_status_updates",
      "linear_save_status_update",
      "linear_get_user",
    ];
    const schemas = await f.tool("clankie_tools", { names: names.slice(0, 10) });
    expect(schemas.isError).not.toBe(true);
    // Discovery limits are unchanged: fetch the remaining schema separately.
    const discovered = JSON.parse(schemas.content[0]!.text);
    expect(discovered.map((tool: { name: string }) => tool.name)).toContain("linear_save_issue");
    const me = await f.call("linear_get_user", { query: "me" });
    expect(JSON.stringify(me).toLowerCase()).toContain("local");
    expect(await f.host.trackerStatus!()).toMatchObject({ backend: "local", reason: "linear_disconnected" });
    const team = await f.call("linear_get_team", { query: "LOCAL" });
    await f.call("linear_create_issue_label", { name: "builder", teamId: team.id });
    const project = await f.call("linear_save_project", { name: "Offline delivery", addTeams: ["LOCAL"] });
    const parent = await f.call("linear_save_issue", {
      team: "LOCAL",
      title: "Parent",
      project: project.id,
      priority: 0,
      description: "Owner text\n\n## Acceptance Criteria\n- [ ] Preserve this\n",
    });
    const child = await f.call("linear_save_issue", {
      team: "LOCAL",
      title: "Urgent child",
      project: project.id,
      priority: 1,
      parentId: parent.id,
      labels: ["builder"],
      blockedBy: [parent.id],
    });
    await f.call("linear_save_issue", { team: "LOCAL", title: "Low item", priority: 4 });
    await f.call("linear_save_issue", { team: "LOCAL", title: "High item", priority: 2 });
    const page = await f.call("linear_list_issues", { team: "LOCAL", state: "unstarted", limit: 2 });
    expect(page.issues.map((issue: { priority: number }) => issue.priority)).toEqual([1, 2]);
    expect(page.hasNextPage).toBe(true);
    const next = await f.call("linear_list_issues", {
      team: "LOCAL",
      state: "unstarted",
      limit: 2,
      cursor: page.cursor,
    });
    expect(next.issues.map((issue: { priority: number }) => issue.priority)).toEqual([4, 0]);
    expect(next.hasNextPage).toBe(false);
    await f.call("linear_save_issue", {
      id: parent.id,
      state: "In Progress",
      priority: 3,
      patch: [{ op: "replace", old_string: "- [ ] Preserve this", new_string: "- [x] Preserve this" }],
      relatedTo: [child.id],
    });
    const fresh = await f.call("linear_get_issue", { id: parent.identifier, includeRelations: true });
    expect(fresh.id).toBe(parent.id);
    expect(fresh.description).toContain("Owner text");
    expect(fresh.description).toContain("- [x] Preserve this");
    const before = fresh.description;
    const failed = await f.tool("clankie_call", {
      name: "linear_save_issue",
      arguments: {
        id: parent.id,
        priority: 1,
        patch: [
          { op: "append", text: "\nshould roll back" },
          { op: "replace", old_string: "absent anchor", new_string: "bad" },
        ],
      },
    });
    expect(failed.isError).toBe(true);
    expect((await f.call("linear_get_issue", { id: parent.id })).description).toBe(before);
    expect((await f.call("linear_get_issue", { id: parent.id })).priority).toBe(3);
    const comment = await f.call("linear_save_comment", { issueId: child.id, body: "Evidence ready" });
    const reply = await f.call("linear_save_comment", { parentId: comment.id, body: "Reviewed" });
    expect(reply.parentId).toBe(comment.id);
    const update = await f.call("linear_save_status_update", {
      type: "project",
      project: project.id,
      body: "Local work verified",
      health: "onTrack",
    });
    await f.call("linear_save_comment", {
      statusUpdateId: update.id,
      statusUpdateType: "project",
      body: "Status evidence",
    });
    expect(
      (
        await f.call("linear_get_project", {
          query: project.id,
          includeMilestones: true,
          includeMembers: true,
          includeResources: true,
        })
      ).name,
    ).toBe("Offline delivery");
    expect(
      JSON.stringify(await f.call("linear_get_status_updates", { type: "project", project: project.id })),
    ).toContain("Local work verified");
    await f.close();
    f = await surface(root);
    expect((await f.call("linear_get_issue", { id: child.identifier })).id).toBe(child.id);
    expect(JSON.stringify(await f.call("linear_list_comments", { issueId: child.id }))).toContain("Reviewed");
    expect(await f.credentials.get("linear")).toBeUndefined();
    expect(await readFile(join(root, "tracker", "tracker.json"), "utf8")).toContain(child.id);
    await f.settings.update((current) => ({ ...current, fleet: { ...current.fleet, tools: "off" } }));
    expect(
      (
        await f.tool("clankie_call", {
          name: "linear_save_issue",
          arguments: { team: "LOCAL", title: "Must be refused" },
        })
      ).isError,
    ).toBe(true);
  } finally {
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("rechecks actual fleet settings at local publication after the initial admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-tracker-fence-"));
  const f = await surface(root);
  try {
    const saved = await f.call("linear_save_issue", {
      team: "LOCAL",
      title: "Before revocation",
      priority: 2,
    });
    const before = await readFile(join(root, "tracker", "tracker.json"), "utf8");
    let admissions = 0;
    let effects = 0;
    const result = await f.host.call({
      lane: "operator",
      server: "linear",
      tool: "save_issue",
      arguments: { id: saved.id, title: "Must remain unpublished" },
      // The host-owned admission callback reads the real SettingsStore. Revoke
      // on its final publication check, after its first check admitted the call.
      fence: async () => {
        if (++admissions === 2)
          await f.settings.update((current) => ({ ...current, fleet: { ...current.fleet, tools: "off" } }));
        const snapshot = await f.settings.loadFenced();
        return () => {
          snapshot.assertCurrent();
          if (snapshot.settings.fleet.tools !== "connected") throw new Error("Fleet tools are off");
        };
      },
      onDispatch: () => {
        effects++;
      },
    });
    expect(admissions).toBe(2);
    expect(result).toMatchObject({ outcome: "refused" });
    expect(result).not.toHaveProperty("possiblyDispatched", true);
    expect(effects).toBe(0);
    expect(await readFile(join(root, "tracker", "tracker.json"), "utf8")).toBe(before);
  } finally {
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps a saved Linear repo convention usable offline without impersonating remote issue IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-tracker-convention-"));
  let f = await surface(root);
  try {
    await f.work(["init", "--backend", "linear", "--linear-team", "VUH", "--linear-project", "Clankie"]);
    const created = await f.work(["create", "Offline conventional item", "--priority", "2"]);
    expect(created.item.id).toMatch(/^LOCAL-VUH-/u);
    // Existing issue briefs and the Linear writing skills supply only the ID.
    const read = await f.call("linear_get_issue", { id: created.item.id });
    expect(read).toMatchObject({
      title: "Offline conventional item",
      priority: 2,
      team: "VUH",
      project: "Clankie",
    });
    const comment = await f.call("linear_save_comment", {
      issueId: created.item.id,
      body: "Unchanged worker brief",
    });
    await f.call("linear_save_comment", {
      parentId: comment.id,
      body: "Reply without repository vocabulary",
    });
    expect(JSON.stringify(await f.call("linear_list_comments", { issueId: created.item.id }))).toContain(
      "Reply without repository vocabulary",
    );
    await f.call("linear_save_issue", { id: created.item.id, priority: 1 });
    expect((await f.work(["show", created.item.id])).item.priority).toBe(1);
    expect(
      (await f.call("linear_list_issues", { team: "VUH", project: "Clankie", state: "unstarted" })).issues[0]
        .id,
    ).toBe(read.id);
    const foreignProject = await f.call("linear_save_project", {
      repo: "workspace",
      name: "Other project",
      addTeams: ["VUH"],
    });
    const ownerCreated = await f.host.call({
      lane: "operator",
      server: "linear",
      tool: "save_issue",
      arguments: { repo: "workspace", team: "VUH", project: foreignProject.id, title: "Outside saved scope" },
      resultMode: "data",
    });
    expect(ownerCreated.outcome).toBe("ok");
    if (ownerCreated.outcome !== "ok") throw new Error(ownerCreated.detail);
    const outside = JSON.parse(ownerCreated.content);
    for (const arguments_ of [
      { id: outside.id, title: "Must be refused" },
      { team: "VUH", project: foreignProject.id, title: "Must not widen scope" },
    ]) {
      const denied = await f.tool("clankie_call", {
        name: "linear_save_issue",
        arguments: { repo: "workspace", ...arguments_ },
      });
      expect(denied.isError).toBe(true);
    }
    expect(
      (
        await f.tool("clankie_call", {
          name: "linear_save_comment",
          arguments: { repo: "workspace", issueId: outside.id, body: "Must be refused" },
        })
      ).isError,
    ).toBe(true);
    const ownerComment = await f.host.call({
      lane: "operator",
      server: "linear",
      tool: "save_comment",
      arguments: { repo: "workspace", issueId: outside.id, body: "Owner's outside thread" },
    });
    expect(ownerComment.outcome).toBe("ok");
    if (ownerComment.outcome !== "ok") throw new Error(ownerComment.detail);
    const outsideComment = JSON.parse(ownerComment.content);
    for (const target of [{ parentId: outsideComment.id }, { id: outsideComment.id }]) {
      expect(
        (
          await f.tool("clankie_call", {
            name: "linear_save_comment",
            arguments: { ...target, body: "Must be refused" },
          })
        ).isError,
      ).toBe(true);
    }
    const untouched = await f.host.call({
      lane: "operator",
      server: "linear",
      tool: "get_issue",
      arguments: { repo: "workspace", id: outside.id },
    });
    expect(untouched.outcome).toBe("ok");
    if (untouched.outcome !== "ok") throw new Error(untouched.detail);
    expect(JSON.parse(untouched.content).title).toBe("Outside saved scope");
    await f.close();
    f = await surface(root);
    expect((await f.work(["show", created.item.id])).item.id).toBe(created.item.id);
    expect((await f.call("linear_get_issue", { id: created.item.id })).id).toBe(read.id);
    expect(await f.credentials.get("linear")).toBeUndefined();
  } finally {
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("resolves existing local brief IDs without enrolling paths and refuses ambiguous identifiers", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-tracker-briefs-"));
  const f = await surface(root);
  try {
    const global = await f.call("linear_save_issue", { team: "LOCAL", title: "Global service issue" });
    await f.work(["init", "--backend", "linear", "--linear-team", "VUH", "--linear-project", "Clankie"]);
    const first = await f.work(["create", "First repo issue"]);
    const secondRepo = join(root, "second-repo");
    await mkdir(secondRepo);
    await f.workItems.handle(
      { action: "init", repo: secondRepo, backend: "linear", linearTeam: "VUH", linearProject: "Clankie" },
      true,
    );
    const second = await f.workItems.handle(
      { action: "create", repo: secondRepo, title: "Second repo issue" },
      true,
    );
    if (!("item" in second)) throw new Error("Expected created issue");
    expect(second.item.id).toBe(first.item.id);
    const before = await readFile(join(root, "work", "work-repos.json"), "utf8");
    const denied = await f.tool("clankie_call", {
      name: "linear_save_issue",
      arguments: { id: first.item.id, title: "Must not choose a repo" },
    });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]?.text).toMatch(/ambiguous/i);
    expect((await f.work(["show", first.item.id])).item.title).toBe("First repo issue");
    expect((await f.call("linear_get_issue", { id: global.id })).title).toBe("Global service issue");
    const known = await f.call("linear_get_issue", { repo: "workspace", id: first.item.id });
    expect((await f.call("linear_get_issue", { id: known.id })).title).toBe("First repo issue");
    expect(await readFile(join(root, "work", "work-repos.json"), "utf8")).toBe(before);
  } finally {
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps clankie work and Markdown issues on the canonical tools with priority, patches and local threads", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-tracker-repo-"));
  const f = await surface(root);
  try {
    await f.work(["init", "--backend", "markdown", "--directory", "docs/tasks"]);
    const low = await f.work(["create", "CLI low", "--priority", "4", "--criterion", "Keep owner prose"]);
    const nativePath = join(f.repo, low.item.location);
    const native = await readFile(nativePath, "utf8");
    const ownerBody =
      "Owner lead.\n\n## Acceptance Criteria\n\nOwner prose around the checklist.\n- [ ] Keep owner prose\n\n## Evidence\n\nOwner's existing caption.\n![original](https://uploads.linear.app/fixture/original.png)\n";
    const frontMatter = /^---\n[\s\S]*?\n---\n/u.exec(native)![0];
    await writeFile(nativePath, frontMatter + ownerBody);
    const urgent = await f.call("linear_save_issue", {
      repo: "workspace",
      team: "LOCAL",
      title: "Tool urgent",
      priority: 1,
      description: "Owner prose",
    });
    expect(
      (await f.work(["list", "--status", "todo"])).items.map((item: { priority: number }) => item.priority),
    ).toEqual([1, 4]);
    const before = await f.call("linear_get_issue", { repo: "workspace", id: low.item.id });
    expect(before.description).toBe(ownerBody);
    expect(
      (await f.call("linear_list_issues", { repo: "workspace", state: "unstarted" })).issues.map(
        (issue: { priority: number }) => issue.priority,
      ),
    ).toEqual([1, 4]);
    await f.call("linear_save_issue", { repo: "workspace", id: low.item.id, priority: 2 });
    expect((await f.call("linear_get_issue", { repo: "workspace", id: low.item.id })).description).toBe(
      ownerBody,
    );
    await f.call("linear_save_issue", {
      repo: "workspace",
      id: low.item.id,
      priority: 2,
      patch: [{ op: "replace", old_string: "- [ ] Keep owner prose", new_string: "- [x] Keep owner prose" }],
      parentId: urgent.id,
      blockedBy: [urgent.id],
    });
    const updated = await f.work(["show", low.item.id]);
    expect(updated.item).toMatchObject({
      priority: 2,
      parent: urgent.id,
      dependsOn: [urgent.id],
      criteria: [{ text: "Keep owner prose", done: true }],
    });
    expect(before.description).toContain("- [ ] Keep owner prose");
    expect((await f.call("linear_get_issue", { repo: "workspace", id: low.item.id })).description).toBe(
      ownerBody.replace("- [ ] Keep owner prose", "- [x] Keep owner prose"),
    );
    const thread = await f.call("linear_save_comment", {
      repo: "workspace",
      issueId: urgent.id,
      body: "Local repo evidence",
    });
    await f.call("linear_save_comment", { repo: "workspace", parentId: thread.id, body: "Local reply" });
    expect(
      JSON.stringify(await f.call("linear_list_comments", { repo: "workspace", issueId: urgent.id })),
    ).toContain("Local reply");
    const refused = await f.tool("clankie_call", { name: "linear_list_issues", arguments: { repo: f.repo } });
    expect(refused.isError).toBe(true);
  } finally {
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("requires a bound GitHub account for delegated tools while keeping the owner CLI's ambient gh access", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-tracker-github-"));
  const ambientLog = join(root, "ambient-gh.jsonl");
  const ambientCommand = join(root, "ambient-gh.mjs");
  await writeFile(ambientLog, "");
  // A real subprocess records any attempted ambient command without using a
  // developer's installed gh or authenticated GitHub workspace.
  await writeFile(
    ambientCommand,
    "import {appendFileSync} from 'node:fs'; appendFileSync(process.argv[2], JSON.stringify(process.argv.slice(3))+'\\n'); process.stdout.write('[[]]');\n",
  );
  const exec = promisify(execFile);
  const issue = {
    number: 42,
    title: "Existing issue",
    body: "Owner prose",
    state: "open",
    html_url: "https://github.com/fixture/tracker/issues/42",
    labels: [] as string[],
  };
  const seen: { method: string; authorization: string | undefined }[] = [];
  const mutations: Record<string, unknown>[] = [];
  let replaceAccount: (() => Promise<void>) | undefined;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    seen.push({ method: request.method ?? "", authorization: request.headers.authorization });
    response.setHeader("content-type", "application/json");
    if (path.endsWith("/parent")) {
      response.writeHead(404).end("{}");
      return;
    }
    if (request.method === "GET" && path === "/repos/fixture/tracker/issues") {
      response.end("[]");
      return;
    }
    if (request.method === "GET" && replaceAccount) {
      const replace = replaceAccount;
      replaceAccount = undefined;
      await replace();
    }
    if (request.method === "PATCH") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const patch = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      mutations.push(patch);
      Object.assign(issue, patch);
    }
    response.end(JSON.stringify(issue));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No fixture port");
  const f = await surface(root, {
    gh: async (args) => (await exec(process.execPath, [ambientCommand, ambientLog, ...args])).stdout,
    githubApiBase: `http://127.0.0.1:${String(address.port)}`,
  });
  try {
    await f.work(["init", "--backend", "github", "--github-repo", "fixture/tracker"]);
    for (const [name, args] of [
      ["linear_list_issues", {}],
      ["linear_save_issue", { team: "LOCAL", title: "Delegated issue" }],
    ] as const) {
      const refused = await f.tool("clankie_call", { name, arguments: { repo: "workspace", ...args } });
      expect(refused.isError).toBe(true);
      expect(refused.content[0]?.text).toMatch(/connect GitHub/iu);
    }
    expect(await readFile(ambientLog, "utf8")).toBe("");
    expect(seen).toEqual([]);
    expect((await f.work(["list"])).items).toEqual([]);
    const ownerCommand = await readFile(ambientLog, "utf8");
    expect(JSON.parse(ownerCommand)).toEqual([
      "api",
      "--paginate",
      "--slurp",
      "repos/fixture/tracker/issues?state=all&per_page=100",
    ]);

    await f.credentials.set("github", { type: "api", key: "isolated-github-account" });
    expect((await f.call("linear_list_issues", { repo: "workspace" })).issues).toEqual([]);
    await f.call("linear_save_issue", { repo: "workspace", id: "#42", title: "Connected delegated edit" });
    expect(issue.title).toBe("Connected delegated edit");
    expect(mutations).toHaveLength(1);
    expect(seen.every((request) => request.authorization === "Bearer isolated-github-account")).toBe(true);
    expect(await readFile(ambientLog, "utf8")).toBe(ownerCommand);

    // Replace the connected account during an actual provider read, before the
    // backend can publish the edit. Neither account may receive a mutation.
    replaceAccount = () => f.credentials.set("github", { type: "api", key: "replacement-github-account" });
    const changed = await f.tool("clankie_call", {
      name: "linear_save_issue",
      arguments: { repo: "workspace", id: "#42", title: "Must remain unpublished" },
    });
    expect(changed.isError).toBe(true);
    expect(changed.content[0]?.text).toContain("Connected GitHub account changed");
    expect(mutations).toHaveLength(1);
    expect(issue.title).toBe("Connected delegated edit");
    expect(await readFile(ambientLog, "utf8")).toBe(ownerCommand);
  } finally {
    await f.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(root, { recursive: true, force: true });
  }
});

it("allocates stable local identifiers across concurrent tool writes and refuses connected failures without local replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "clankie-tracker-switch-"));
  const f = await surface(root);
  try {
    const records = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        f.call("linear_save_issue", {
          team: "LOCAL",
          title: `Concurrent ${index}`,
          priority: (index % 4) + 1,
        }),
      ),
    );
    expect(new Set(records.map((record) => record.id)).size).toBe(8);
    expect(new Set(records.map((record) => record.identifier)).size).toBe(8);
    const store = await readFile(join(root, "tracker", "tracker.json"), "utf8");
    await f.credentials.set("linear", {
      type: "api",
      key: "isolated-fixture-key",
      account: {
        provider: "linear",
        actor: "app",
        connectionId: randomUUID(),
        userId: "fixture",
        workspaceId: "fixture",
        name: "Isolated fixture",
        workspaceName: "Isolated fixture",
        verifiedAt: new Date().toISOString(),
      },
    });
    expect(await f.host.trackerStatus!()).toMatchObject({ backend: "linear", reason: "owner_connected" });
    const result = await f.host.call({
      lane: "operator",
      server: "linear",
      tool: "save_issue",
      arguments: { team: "LOCAL", title: "Never fall back" },
    });
    expect(result.outcome).toBe("refused");
    expect(await readFile(join(root, "tracker", "tracker.json"), "utf8")).toBe(store);
    await f.credentials.delete("linear");
    expect(await f.host.trackerStatus!()).toMatchObject({ backend: "local", reason: "linear_disconnected" });
    expect((await f.call("linear_list_issues", { team: "LOCAL" })).issues).toHaveLength(8);
  } finally {
    await f.close();
    await rm(root, { recursive: true, force: true });
  }
});
