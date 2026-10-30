import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  OperatorConversationServiceResultSchema,
  OPERATOR_CONVERSATION_DISPATCH_PATH,
} from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createWorkItemsService, defaultRun } from "../src/work-items.ts";

const clock = () => new Date("2026-09-26T12:00:00.000Z");
const noGit = async () => {
  throw new Error("no git here");
};

async function fixture(repoFiles: Record<string, string> = {}) {
  const stateDirectory = await mkdtemp(join(tmpdir(), "work-state-"));
  const repo = await mkdtemp(join(tmpdir(), "work-repo-"));
  for (const [path, text] of Object.entries(repoFiles)) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  const workspace = await mkdtemp(join(tmpdir(), "work-workspace-"));
  const service = createWorkItemsService({ stateDirectory, workspace: () => workspace, run: noGit, clock });
  return { service, repo, workspace, stateDirectory };
}

describe("the work-items service", () => {
  it("lists the working directory as workspace and registers repos a local caller names", async () => {
    const { service, repo, workspace } = await fixture();
    const before = await service.handle({ action: "repos" }, true);
    expect(before).toEqual({ repos: [expect.objectContaining({ id: "workspace", needsDecision: true })] });
    const created = await service.handle(
      { action: "create", repo, title: "Board view", criteria: ["iPhone"] },
      true,
    );
    expect(created).toMatchObject({ item: { status: "todo", criteria: [{ text: "iPhone", done: false }] } });
    const repos = await service.handle({ action: "repos" }, true);
    const registered = "repos" in repos ? repos.repos.find((entry) => entry.id !== "workspace") : undefined;
    expect(registered).toMatchObject({ backend: "default", needsDecision: false, root: repo });
    // The root is what joins a repo's work to the directory a seat works in.
    expect("repos" in before ? before.repos[0]?.root : undefined).toBe(resolve(workspace));
    const listed = await service.handle({ action: "list", repo: registered!.id }, false);
    expect("items" in listed ? listed.items.map((item) => item.title) : []).toEqual(["Board view"]);
    expect(JSON.parse(await readFile(join(repo, ".clankie/tracking.json"), "utf8"))).toMatchObject({
      backend: "default",
      decidedBy: "discovery",
    });
  });

  // A real checkout, and a worktree where Claude Code keeps a subagent's: `.claude/worktrees/agent-…`.
  async function checkoutWithWorktree(committed: Record<string, string> = {}) {
    const repo = await mkdtemp(join(tmpdir(), "work-checkout-"));
    const git = (...args: string[]) =>
      defaultRun("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], repo);
    await git("init", "-q", "-b", "main");
    for (const [path, text] of Object.entries({ "README.md": "x\n", ...committed })) {
      await mkdir(join(repo, path, ".."), { recursive: true });
      await writeFile(join(repo, path), text);
    }
    await git("add", "-A");
    await git("commit", "-q", "-m", "init");
    const worktree = join(repo, ".claude", "worktrees", "agent-a1d73e1df10623670");
    await git("worktree", "add", "-q", "--detach", worktree);
    const service = createWorkItemsService({
      stateDirectory: await mkdtemp(join(tmpdir(), "work-state-")),
      run: defaultRun,
      clock,
    });
    const repos = async () => {
      const result = await service.handle({ action: "repos" }, true);
      return "repos" in result ? result.repos : [];
    };
    return { repo, worktree, service, repos };
  }

  it("names a worktree after its checkout and shares the checkout's private issue files (VUH-2848, step 5 C2)", async () => {
    const { repo, worktree, service, repos } = await checkoutWithWorktree();
    // An agent in the worktree names its path first: no folder name, the checkout's.
    await service.handle({ action: "create", repo: worktree, title: "From the worktree" }, true);
    expect((await repos()).map((entry) => [entry.name, entry.root])).toEqual([[basename(repo), worktree]]);
    // The item is written once, in the main checkout's private folder, never in the worktree.
    expect(readdirSync(join(repo, ".clankie/work")).filter((name) => name.endsWith(".md"))).toHaveLength(1);
    expect(existsSync(join(worktree, ".clankie/work"))).toBe(false);
    // Once the checkout is known too, it is offered once: both read the same files.
    await service.handle({ action: "list", repo }, true);
    const offered = await repos();
    expect(offered.map((entry) => [entry.name, entry.root])).toEqual([[basename(repo), repo]]);
    // A device enumerating what it is offered still finds the worktree's item.
    const titles = [];
    for (const entry of offered) {
      const listed = await service.handle({ action: "list", repo: entry.id }, false);
      if ("items" in listed) titles.push(...listed.items.map((item) => item.title));
    }
    expect(titles).toEqual(["From the worktree"]);
    // The worktree reads the same item, and git sees nothing to commit in the checkout.
    const fromWorktree = await service.handle({ action: "list", repo: worktree }, true);
    expect("items" in fromWorktree ? fromWorktree.items.map((item) => item.title) : []).toEqual([
      "From the worktree",
    ]);
    expect(await defaultRun("git", ["status", "--porcelain", "--", ".clankie/work"], repo)).toBe("");
  });

  it("brings a worktree's own older issue files into the shared folder once, losing none", async () => {
    const { repo, worktree, service } = await checkoutWithWorktree();
    // Before the folder was shared, an agent in the worktree kept its items there.
    const legacy = join(worktree, ".clankie/work");
    await mkdir(legacy, { recursive: true });
    const item = (id: string, title: string) =>
      `---\nid: ${id}\ntitle: ${title}\nstatus: todo\npriority: 0\n---\n# ${title}\n`;
    await writeFile(join(legacy, "W-old001-kept-in-worktree.md"), item("W-old001", "Kept in the worktree"));
    await writeFile(join(legacy, "W-old002-also-older.md"), item("W-old002", "Also older"));
    const titles = async (path: string) => {
      const listed = await service.handle({ action: "list", repo: path }, true);
      return "items" in listed ? listed.items.map((entry) => entry.title).sort() : [];
    };
    expect(await titles(worktree)).toEqual(["Also older", "Kept in the worktree"]);
    expect(await titles(repo)).toEqual(["Also older", "Kept in the worktree"]);
    // An update reaches the item where it now lives, and the worktree's files are left alone.
    await service.handle({ action: "update", repo: worktree, id: "W-old001", status: "in_progress" }, true);
    const shared = readdirSync(join(repo, ".clankie/work")).filter((name) => name.endsWith(".md"));
    expect(shared).toHaveLength(2);
    expect(readdirSync(legacy).sort()).toEqual(["W-old001-kept-in-worktree.md", "W-old002-also-older.md"]);
    // Once is enough: a later read never copies them again.
    await service.handle({ action: "create", repo: worktree, title: "New in the shared folder" }, true);
    expect(await titles(worktree)).toEqual([
      "Also older",
      "Kept in the worktree",
      "New in the shared folder",
    ]);
  });

  it("keeps a worktree listed when it keeps its issue files in another private folder", async () => {
    const tracking = (directory: string) =>
      JSON.stringify({
        schemaVersion: 1,
        backend: "markdown",
        directory,
        decidedBy: "owner",
        decidedAt: "2026-10-30T00:00:00.000Z",
      });
    const { repo, worktree, service, repos } = await checkoutWithWorktree({
      ".clankie/tracking.json": tracking(".clankie/work/garden"),
    });
    await writeFile(join(worktree, ".clankie/tracking.json"), tracking(".clankie/work/orchard/"));
    await service.handle({ action: "create", repo: worktree, title: "Orchard item" }, true);
    await service.handle({ action: "create", repo, title: "Garden item" }, true);
    // Both folders live in the checkout, but they hold different items, so both are offered.
    const offered = await repos();
    expect(offered.map((entry) => entry.root).sort()).toEqual([repo, worktree].sort());
    const titles = [];
    for (const entry of offered) {
      const listed = await service.handle({ action: "list", repo: entry.id }, false);
      if ("items" in listed) titles.push(...listed.items.map((item) => item.title));
    }
    expect(titles.sort()).toEqual(["Garden item", "Orchard item"]);
    expect(
      readdirSync(join(repo, ".clankie/work/orchard")).filter((name) => name.endsWith(".md")),
    ).toHaveLength(1);
  });

  it("offers a checkout once when its worktree reads the same Linear project (VUH-2848)", async () => {
    const tracking = {
      schemaVersion: 1,
      backend: "linear",
      linear: { team: "VUH", project: "clankie" },
      decidedBy: "owner",
      decidedAt: "2026-09-26T00:00:00.000Z",
    };
    const { repo, worktree, service, repos } = await checkoutWithWorktree({
      ".clankie/tracking.json": JSON.stringify(tracking),
    });
    // Naming a path registers it; this fixture has no Linear connection to read items with.
    await service.handle({ action: "list", repo: worktree }, true).catch(() => undefined);
    expect((await repos()).map((entry) => [entry.name, entry.root])).toEqual([[basename(repo), worktree]]);
    await service.handle({ action: "list", repo }, true).catch(() => undefined);
    expect((await repos()).map((entry) => [entry.name, entry.root])).toEqual([[basename(repo), repo]]);
  });

  it("never lets a device name a path or write", async () => {
    const { service, repo } = await fixture();
    await expect(service.handle({ action: "list", repo }, false)).rejects.toMatchObject({
      code: "unknown_repo",
    });
    await expect(
      service.handle({ action: "create", repo: "workspace", title: "x" }, false),
    ).rejects.toMatchObject({
      code: "invalid",
    });
    await expect(
      service.handle({ action: "init", repo: "workspace", backend: "default" }, false),
    ).rejects.toMatchObject({
      code: "invalid",
    });
  });

  it("returns the owner's question instead of choosing, then follows the recorded answer", async () => {
    const { service, repo } = await fixture({ "TODO.md": "- a", "docs/tasks/T-1-first.md": "# First" });
    // One item directory plus a TODO.md is unambiguous: the directory wins.
    expect(await service.handle({ action: "discover", repo }, true)).toMatchObject({
      signals: expect.any(Array),
    });
    const ambiguous = await fixture({ "TODO.md": "- a" });
    await expect(
      service.handle({ action: "create", repo: ambiguous.repo, title: "x" }, true),
    ).rejects.toMatchObject({
      code: "needs_decision",
      question: expect.stringMatching(/single task list/u),
    });
    await service.handle(
      { action: "init", repo: ambiguous.repo, backend: "markdown", directory: "docs/work" },
      true,
    );
    const created = await service.handle(
      { action: "create", repo: ambiguous.repo, title: "Agent task" },
      true,
    );
    expect(created).toMatchObject({ item: { location: expect.stringMatching(/^docs\/work\//u) } });
    expect(existsSync(join(ambiguous.repo, ".clankie/work"))).toBe(false);
  });

  it("keeps explicit owner work init able to replace a saved tracking choice", async () => {
    const { service, repo } = await fixture();
    await service.handle({ action: "init", repo, backend: "default" }, true);
    const before = await readFile(join(repo, ".clankie/tracking.json"), "utf8");
    await service.handle({ action: "init", repo, backend: "markdown", directory: "docs/work" }, true);
    const saved = await readFile(join(repo, ".clankie/tracking.json"), "utf8");
    expect(saved).not.toBe(before);
    expect(JSON.parse(saved)).toMatchObject({
      backend: "markdown",
      directory: "docs/work",
      decidedBy: "owner",
    });
  });

  it("updates release settings through shared work init without replacing the saved tracker", async () => {
    const { service, repo } = await fixture();
    await service.handle(
      {
        action: "init",
        repo,
        backend: "linear",
        linearTeam: "VUH",
        linearProject: "Clankie",
        linearLabel: "repo-board",
        releaseSource: "both",
        releaseLane: "mobile",
        note: "Keep the owner's tracker",
      },
      true,
    );
    const path = join(repo, ".clankie/tracking.json");
    const before = JSON.parse(await readFile(path, "utf8"));
    await service.handle({ action: "init", repo, releaseSource: "tags" }, true);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      ...before,
      releases: { source: "tags", lane: "mobile" },
    });
    await service.handle({ action: "init", repo, releaseLane: "macos" }, true);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      ...before,
      releases: { source: "tags", lane: "macos" },
    });
  });

  it("persists a Linear-shaped local fallback in the saved repo scope when Linear is disconnected", async () => {
    const { service, repo, stateDirectory, workspace } = await fixture();
    await service.handle(
      {
        action: "init",
        repo,
        backend: "linear",
        linearTeam: "VUH",
        linearProject: "Clankie",
        linearLabel: "repo-board",
      },
      true,
    );
    const created = await service.handle(
      { action: "create", repo, title: "Offline task", priority: 2 },
      true,
    );
    expect(created).toMatchObject({ item: { id: "LOCAL-VUH-1", priority: 2, labels: ["repo-board"] } });
    if (!("item" in created)) throw new Error("Expected an issue");
    const reopened = createWorkItemsService({
      stateDirectory,
      workspace: () => workspace,
      run: noGit,
      clock,
    });
    expect(await reopened.handle({ action: "show", repo, id: created.item.id }, true)).toMatchObject({
      item: { id: created.item.id, title: "Offline task", priority: 2 },
    });
    expect(await reopened.handle({ action: "list", repo }, true)).toMatchObject({
      items: [{ id: created.item.id }],
    });
    expect(existsSync(join(repo, ".clankie/work"))).toBe(false);
  });
});

describe("the work routes", () => {
  it("returns oversized stored summaries in full through CLI and device APIs and accepts them from both writers", async () => {
    const { service, repo, stateDirectory, workspace } = await fixture();
    await service.handle(
      { action: "init", repo, backend: "linear", linearTeam: "VUH", linearProject: "Clankie" },
      true,
    );
    const summary = `Stored prose\n${"x".repeat(24_000)}\nEnd of stored prose.`;
    const saved = (await service.callTracker(
      "save_issue",
      { team: "VUH", project: "Clankie", title: "Large canonical item", description: summary },
      { repo, local: true },
    )) as { identifier: string };
    // Reopen the real persisted tracker rather than reading a writer's return value.
    const reopened = createWorkItemsService({
      stateDirectory,
      workspace: () => workspace,
      run: noGit,
      clock,
    });
    const { app, close } = await createClankieApp({
      captain: createStubCaptain(),
      workItems: reopened,
      authenticateOperator: async () => ({ operatorId: "owner" }),
      authenticateCaptain: async () => ({ captainId: "operator", steerSourceLane: "api" }),
    });
    const post = async (path: string, body: unknown) => {
      const response = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    try {
      expect(await post("/v1/work", { action: "show", repo, id: saved.identifier })).toMatchObject({
        item: { summary },
      });
      expect(await post("/v1/work", { action: "list", repo })).toMatchObject({ items: [{ summary }] });
      const repos = await reopened.handle({ action: "repos" }, true);
      if (!("repos" in repos)) throw new Error("Expected repos");
      const repoId = repos.repos.find((entry) => entry.root === repo)!.id;
      const device = OperatorConversationServiceResultSchema.parse(
        await post(OPERATOR_CONVERSATION_DISPATCH_PATH, {
          op: "work_items",
          schemaVersion: 1,
          repoId,
          itemId: saved.identifier,
        }),
      );
      expect(device).toMatchObject({ result: { outcome: "ready", items: [{ summary }] } });
      expect(
        await post("/v1/work", { action: "create", repo, title: "Large CLI item", summary }),
      ).toMatchObject({
        item: { summary },
      });
      await reopened.callTracker(
        "save_issue",
        { id: saved.identifier, patch: [{ op: "append", text: "\nCanonical patch retained." }] },
        { repo, local: true },
      );
      expect(await post("/v1/work", { action: "show", repo, id: saved.identifier })).toMatchObject({
        item: { summary: `${summary}\nCanonical patch retained.` },
      });
    } finally {
      close();
    }
  });

  it("serves the CLI contract to the operator and read-only ops to devices", async () => {
    const { service, workspace } = await fixture();
    await service.handle({ action: "create", repo: "workspace", title: "Seen from the phone" }, true);
    const { app } = await createClankieApp({
      captain: createStubCaptain(),
      workItems: service,
      authenticateOperator: async (request) =>
        request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
      authenticateCaptain: async () => ({ captainId: "operator", steerSourceLane: "api" }),
    });
    const post = (path: string, body: unknown, token = "owner") =>
      app.request(path, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post("/v1/work", { action: "repos" }, "nobody")).status).toBe(401);
    expect((await post("/v1/work", { action: "explode" })).status).toBe(400);
    expect((await post("/v1/work", { action: "show", repo: "workspace", id: "W-none00" })).status).toBe(404);
    const listed = (await (await post("/v1/work", { action: "list", repo: workspace })).json()) as {
      items: { title: string }[];
    };
    expect(listed.items.map((item) => item.title)).toEqual(["Seen from the phone"]);

    const repos = (await (
      await post(OPERATOR_CONVERSATION_DISPATCH_PATH, { op: "work_repos", schemaVersion: 1 })
    ).json()) as {
      repos: { id: string }[];
    };
    expect(repos.repos.map((repo) => repo.id)).toContain("workspace");
    const items = (await (
      await post(OPERATOR_CONVERSATION_DISPATCH_PATH, {
        op: "work_items",
        schemaVersion: 1,
        repoId: "workspace",
      })
    ).json()) as { result: { outcome: string; items: { title: string }[] } };
    expect(items.result).toMatchObject({ outcome: "ready", items: [{ title: "Seen from the phone" }] });
    const unknown = (await (
      await post(OPERATOR_CONVERSATION_DISPATCH_PATH, {
        op: "work_items",
        schemaVersion: 1,
        repoId: "nope-12345678",
      })
    ).json()) as { result: { outcome: string } };
    expect(unknown.result.outcome).toBe("unavailable");

    // A role station reads its backlog by label (ADR 0208).
    const [file] = readdirSync(join(workspace, ".clankie/work")).filter((name) => name.endsWith(".md"));
    const path = join(workspace, ".clankie/work", file!);
    writeFileSync(path, readFileSync(path, "utf8").replace(/^---\n/u, "---\nlabels: [Designer]\n"));
    const station = async (label: string) =>
      (
        (await (
          await post(OPERATOR_CONVERSATION_DISPATCH_PATH, {
            op: "work_items",
            schemaVersion: 1,
            repoId: "workspace",
            label,
          })
        ).json()) as { result: { items: { title: string; labels?: string[] }[] } }
      ).result.items;
    expect(await station("designer")).toMatchObject([{ title: "Seen from the phone", labels: ["Designer"] }]);
    expect(await station("builder")).toEqual([]);
    const cli = (await (
      await post("/v1/work", { action: "list", repo: workspace, label: "DESIGNER" })
    ).json()) as { items: unknown[] };
    expect(cli.items).toHaveLength(1);

    // A direct read reaches one item without the list, and finds none for an unknown ID (VUH-1954).
    const { id } = (cli.items as { id: string }[])[0]!;
    const direct = async (itemId: string) =>
      (
        (await (
          await post(OPERATOR_CONVERSATION_DISPATCH_PATH, {
            op: "work_items",
            schemaVersion: 1,
            repoId: "workspace",
            itemId,
            label: "builder",
          })
        ).json()) as { result: { outcome: string; repo: { id: string }; items: { id: string }[] } }
      ).result;
    expect(await direct(id)).toMatchObject({ outcome: "ready", repo: { id: "workspace" }, items: [{ id }] });
    expect(await direct("W-none00")).toMatchObject({
      outcome: "ready",
      repo: { id: "workspace" },
      items: [],
    });
  });
});

it("negotiates backlog at the device boundary and exposes project facts over the authenticated API", async () => {
  const { service, workspace } = await fixture();
  await service.handle(
    {
      action: "init",
      repo: "workspace",
      backend: "default",
      releaseSource: "milestones",
      releaseLane: "mobile",
    },
    true,
  );
  await service.handle(
    { action: "create", repo: "workspace", title: "Later work", status: "backlog", priority: 2 },
    true,
  );
  const { app } = await createClankieApp({
    captain: createStubCaptain(),
    workItems: service,
    authenticateOperator: async () => ({ operatorId: "owner" }),
    authenticateCaptain: async () => ({ captainId: "operator", steerSourceLane: "api" }),
  });
  const dispatch = async (body: unknown) => {
    const response = await app.request(OPERATOR_CONVERSATION_DISPATCH_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return OperatorConversationServiceResultSchema.parse(await response.json());
  };
  expect(await dispatch({ op: "work_items", schemaVersion: 1, repoId: "workspace" })).toMatchObject({
    result: { items: [{ status: "todo" }] },
  });
  expect(
    await dispatch({ op: "work_items", schemaVersion: 1, repoId: "workspace", statusVersion: 2 }),
  ).toMatchObject({ result: { items: [{ status: "backlog", priority: 2 }] } });
  expect(await dispatch({ op: "work_project", schemaVersion: 1, repoId: "workspace" })).toMatchObject({
    result: {
      outcome: "ready",
      releaseSource: "milestones",
      planned: [],
      shipped: [],
      goals: [],
      unavailable: [{ read: "planned" }],
    },
  });
  expect(await dispatch({ op: "work_project", schemaVersion: 1, repoId: "unknown" })).toMatchObject({
    result: { outcome: "unavailable" },
  });
  await expect(service.handle({ action: "project", repo: workspace }, false)).rejects.toMatchObject({
    code: "unknown_repo",
  });
});

it("reads an item's comments over the device contract and answers unavailable where the tracker keeps none", async () => {
  const { service, repo } = await fixture();
  await service.handle(
    { action: "init", repo, backend: "linear", linearTeam: "VUH", linearProject: "Clankie" },
    true,
  );
  const created = await service.handle({ action: "create", repo, title: "Offline task" }, true);
  if (!("item" in created)) throw new Error("Expected an issue");
  await service.callTracker(
    "save_comment",
    { issueId: created.item.id, body: "Landed on main (Codex, gpt-5.5)." },
    { repo, local: true },
  );
  const { repos } = (await service.handle({ action: "repos" }, true)) as {
    repos: { id: string; root?: string }[];
  };
  const repoId = repos.find((entry) => entry.root === repo)!.id;
  const { app } = await createClankieApp({
    captain: createStubCaptain(),
    workItems: service,
    authenticateOperator: async () => ({ operatorId: "owner" }),
    authenticateCaptain: async () => ({ captainId: "operator", steerSourceLane: "api" }),
  });
  const dispatch = async (body: unknown) => {
    const response = await app.request(OPERATOR_CONVERSATION_DISPATCH_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return OperatorConversationServiceResultSchema.parse(await response.json());
  };
  expect(
    await dispatch({ op: "work_item_activity", schemaVersion: 1, repoId, itemId: created.item.id }),
  ).toMatchObject({
    result: {
      outcome: "ready",
      itemId: created.item.id,
      entries: [{ kind: "comment", body: "Landed on main (Codex, gpt-5.5).", actor: expect.any(String) }],
    },
  });
  // A Markdown tracker keeps no comments: the device hears why, never an empty trail.
  expect(
    await dispatch({ op: "work_item_activity", schemaVersion: 1, repoId: "workspace", itemId: "W-none00" }),
  ).toMatchObject({ result: { outcome: "unavailable" } });
});

it("reads project details and authored updates through the device contract, with unavailable for an unsupported tracker", async () => {
  const { service, repo } = await fixture();
  await service.handle(
    { action: "init", repo, backend: "linear", linearTeam: "VUH", linearProject: "Clankie" },
    true,
  );
  await service.callTracker(
    "save_project",
    {
      id: "Clankie",
      summary: "Build beside Clankie",
      description: "**The plan:** ship the Work screens.",
      priority: 2,
    },
    { repo, local: true },
  );
  const authoredUpdate = await service.callTracker(
    "save_status_update",
    { type: "project", project: "Clankie", body: "**Working:** Overview and Activity.", health: "onTrack" },
    { repo, local: true },
  );
  if (!authoredUpdate || typeof authoredUpdate !== "object" || !("createdAt" in authoredUpdate))
    throw new Error("Expected an authored update");
  const listed = await service.handle({ action: "repos" }, true);
  if (!("repos" in listed)) throw new Error("Expected repos");
  const repoId = listed.repos.find((entry) => entry.root === repo)!.id;
  const { app } = await createClankieApp({
    captain: createStubCaptain(),
    workItems: service,
    authenticateOperator: async () => ({ operatorId: "owner" }),
    authenticateCaptain: async () => ({ captainId: "operator", steerSourceLane: "api" }),
  });
  const read = async (id: string) => {
    const response = await app.request(OPERATOR_CONVERSATION_DISPATCH_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "work_project_details", schemaVersion: 1, repoId: id }),
    });
    expect(response.status).toBe(200);
    return OperatorConversationServiceResultSchema.parse(await response.json());
  };
  expect(await read(repoId)).toMatchObject({
    result: {
      outcome: "ready",
      summary: "Build beside Clankie",
      description: "**The plan:** ship the Work screens.",
      priority: 2,
      updates: [
        {
          body: "**Working:** Overview and Activity.",
          health: "onTrack",
          author: expect.any(String),
          createdAt: authoredUpdate.createdAt,
        },
      ],
    },
  });
  expect(await read("workspace")).toMatchObject({ result: { outcome: "unavailable" } });
});
