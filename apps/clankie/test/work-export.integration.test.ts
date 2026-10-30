import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, expect, it } from "vitest";
import { WORK_TRACKER_SETTINGS_PATH } from "@clankie/protocol";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import type { WorkConvention } from "@clankie/protocol/work-items";
import { SettingsStore } from "@clankie/settings";
import {
  createFilesBackend,
  createLocalTracker,
  promoteLinearImport,
  readConvention,
  TRACKER_LEAD,
  TRACKER_OWNER,
  writeConvention,
  type LinearImportSnapshot,
} from "@clankie/work-items";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { createWorkItemsService, defaultRun } from "../src/work-items.ts";
import { createWorkTrackerSettingsRoutes } from "../src/work-tracker-settings.ts";
import { runWorkCommand } from "../../tui/src/command/work.ts";

/**
 * Step 5, C2: `clankie work export` moves a project's open items into the repo's private
 * `.clankie/work/` issue files. Real surfaces throughout: the CLI over HTTP with the operator
 * credential, the service route, the built-in tracker seeded through its own tools (with the
 * real captured Clankie Work Linear graph imported as the real-data golden), the offline
 * Linear-shaped tracker for a Linear-backed project, real git with a linked worktree, the
 * files backend reading the result, and the tracker settings route for the second step.
 */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

const lead = { ...TRACKER_LEAD, onBehalfOf: [TRACKER_OWNER] };
// The owner seeds: only the owner creates or closes an item as completed.
const owner = { ...TRACKER_OWNER, onBehalfOf: [] };
const git = (cwd: string, ...args: string[]) =>
  defaultRun("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], cwd);

async function checkout(root: string, name: string, convention: WorkConvention) {
  const repo = join(root, name);
  await mkdir(repo);
  await git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "README.md"), `${name}\n`);
  await writeConvention(repo, convention);
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "init");
  const worktree = join(root, `${name}-worktree`);
  await git(repo, "worktree", "add", "-q", "--detach", worktree);
  return { repo, worktree };
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "work-export-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const convention = (backend: "builtin" | "linear"): WorkConvention => ({
    schemaVersion: 1,
    backend,
    ...(backend === "linear" ? { linear: { team: "VUH", project: "Clankie" } } : {}),
    decidedBy: "owner",
    decidedAt: "2026-10-30T00:00:00.000Z",
  });
  const app = await checkout(root, "app", convention("builtin"));
  const linear = await checkout(root, "linear-app", convention("linear"));
  const auto = await checkout(root, "auto-app", convention("builtin"));

  // The built-in store, holding the real captured Clankie Work project (VUH-1963's capture),
  // imported into a scratch store and promoted to the live one as `work cutover linear` does.
  const snapshot = JSON.parse(
    await readFile(
      new URL("../../../packages/work-items/test/fixtures/linear-import/clankie-work.json", import.meta.url),
      "utf8",
    ),
  ) as LinearImportSnapshot;
  await createLocalTracker({ directory: join(root, "scratch") }).importLinear(
    snapshot,
    Object.fromEntries(snapshot.actors.map((actor) => [actor.id, { ...TRACKER_OWNER, onBehalfOf: [] }])),
  );
  await promoteLinearImport({
    source: join(root, "scratch"),
    target: join(root, "tracker"),
    backup: join(root, "before.json"),
    linearProjectId: snapshot.projects[0]!.id,
    scratch: "scratch",
    actor: { ...TRACKER_OWNER, onBehalfOf: [] },
    verify: () => {},
  });
  const tracker = createLocalTracker({ directory: join(root, "tracker") });
  const projectId = snapshot.projects[0]!.id;
  const promote = await tracker.call(
    "save_project",
    { name: "Auto App", addTeams: ["VUH"] },
    { actor: lead },
  );
  const settings = new SettingsStore(join(root, "settings.json"));
  const workspace = (path: string) => [{ id: "primary", machineId: "local", platform: "posix", path }];
  const trackerRef = { workspaceId: "primary", path: ".clankie/tracking.json" };
  await settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        { id: "app", name: "App", workspaces: workspace(app.repo), trackerRef, trackerProjectId: projectId },
        { id: "linear-app", name: "Linear App", workspaces: workspace(linear.repo), trackerRef },
        // A second project in the same checkout, bound to another tracker project.
        {
          id: "app-side",
          name: "App Side",
          workspaces: workspace(app.repo),
          trackerRef,
          trackerProjectId: (promote as { id: string }).id,
        },
        {
          id: "auto-app",
          name: "Auto App",
          workspaces: workspace(auto.repo),
          trackerRef,
          trackerProjectId: (promote as { id: string }).id,
          auto: true,
        },
      ],
    }),
  }));
  const service = createWorkItemsService({
    stateDirectory: root,
    projects: async () => (await settings.load()).projects,
    localMachineId: "local",
    run: defaultRun,
  });
  const host = await createClankieApp({
    captain: createStubCaptain(),
    settings,
    builtInTracker: tracker,
    workItems: service,
    eventLogPath: join(root, "events.jsonl"),
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" ? { operatorId: "owner" } : undefined,
  });
  /** `clankie work` as the owner's terminal runs it: the CLI over HTTP with the operator credential. */
  const workIn = (repo: string, ...args: string[]) =>
    runWorkCommand([...args, "--repo", repo], {
      env: { CLANKIE_OPERATOR_TOKEN: "owner", CLANKIE_CONTROL_PLANE_URL: "http://clankie.test" },
      fetchImpl: (input, init) => Promise.resolve(host.app.request(String(input), init)),
    }) as Promise<{ ok: boolean; body: Record<string, any> }>;
  const work = (...args: string[]) => workIn(app.worktree, ...args);
  const sideProjectId = (promote as { id: string }).id;
  return { root, app, linear, auto, tracker, projectId, sideProjectId, settings, service, work, workIn };
}

const mdFiles = async (directory: string) =>
  existsSync(directory) ? (await readdir(directory)).filter((name) => name.endsWith(".md")).sort() : [];

it("exports a built-in project's open items into private issue files every worktree shares", async () => {
  const f = await fixture();
  const save = async (args: Record<string, unknown>) =>
    (await f.tracker.call(
      "save_issue",
      { team: "VUH", project: f.projectId, ...args },
      { actor: owner },
    )) as {
      id: string;
      identifier: string;
    };
  await f.tracker.call("save_issue_label", { name: "Designer" }, { actor: owner });
  const parent = await save({
    title: "Issue files replace the Work board",
    state: "Todo",
    priority: 2,
    labels: ["Designer"],
    description: [
      "Agents turn drops into issue files.",
      "",
      "## Acceptance Criteria",
      "",
      "- [x] Export writes open items",
      "- [ ] Worktrees share them",
      "",
      "## Evidence",
      "",
      "- image: [Board on iPhone](https://files.example/board.png)",
      "",
      "## Notes",
      "",
      "Owner-authored section stays.",
    ].join("\n"),
    links: [{ url: "https://files.example/run.log", title: "Export run log" }],
    ownerCheck: "Open Work, tap a file: it opens",
  });
  const child = await save({
    title: "Drops become stub files",
    state: "In Review",
    parentId: parent.id,
    blockedBy: [parent.id],
  });
  // Closing as Done needs a verified evidence bundle; a canceled item is closed too.
  const done = await save({ title: "Already shipped", state: "Canceled" });
  await save({ title: "Dropped idea", state: "Canceled" });
  const folder = join(f.app.repo, ".clankie/work");

  // The dry run plans every file and writes nothing.
  const dry = await f.work("export", "--project", "app", "--to", "markdown", "--dry-run", "--json");
  expect(dry.ok).toBe(true);
  expect(dry.body).toMatchObject({
    action: "export",
    dryRun: true,
    ready: true,
    source: { backend: "builtin", trackerProjectId: f.projectId },
    directory: ".clankie/work",
    gitignore: { file: ".clankie/work/.gitignore", action: "create" },
    // Real-data golden: of the captured project's five issues, VUH-1907 and VUH-1905 are open.
    counts: { create: 4, update: 0, unchanged: 0, kept: 0, closedSkipped: 5 },
  });
  expect(dry.body.items.map((item: { id: string }) => item.id).sort()).toEqual(
    ["VUH-1905", "VUH-1907", parent.identifier, child.identifier].sort(),
  );
  expect(existsSync(folder)).toBe(false);
  // The other project in this checkout reads its own tracker project, which holds nothing.
  const side = await f.work("export", "--project", "app-side", "--to", "markdown", "--dry-run");
  expect(side.body).toMatchObject({
    ready: true,
    source: { backend: "builtin", trackerProjectId: f.sideProjectId },
    counts: { create: 0, closedSkipped: 0 },
  });

  // Run from the worktree: the files land once, in the main checkout, and git never sees them.
  const exported = await f.work("export", "--project", "app", "--to", "markdown");
  expect(exported.ok).toBe(true);
  expect(exported.body).toMatchObject({
    dryRun: false,
    root: f.app.repo,
    gitignore: { action: "create" },
    counts: { create: 4, closedSkipped: 5 },
  });
  expect(exported.body.next.join("\n")).toContain(
    `clankie project settings app tracker '{"backend":"markdown","directory":".clankie/work"}'`,
  );
  expect(await mdFiles(folder)).toHaveLength(4);
  expect(existsSync(join(f.app.worktree, ".clankie/work"))).toBe(false);
  expect(await git(f.app.repo, "status", "--porcelain")).toBe("");
  expect(await git(f.app.worktree, "status", "--porcelain")).toBe("");

  // Read back through the files backend, from the worktree: ids and fields round-trip.
  const files = createFilesBackend({ root: f.app.worktree, directory: ".clankie/work", kind: "markdown" });
  const items = await files.list();
  expect(items.map((item) => [item.id, item.status]).sort()).toEqual(
    [
      ["VUH-1905", "in_progress"],
      ["VUH-1907", "backlog"],
      [parent.identifier, "todo"],
      [child.identifier, "in_review"],
    ].sort(),
  );
  const parentFile = await files.get(parent.identifier);
  expect(parentFile).toMatchObject({
    title: "Issue files replace the Work board",
    priority: 2,
    labels: ["Designer"],
    criteria: [
      { text: "Export writes open items", done: true },
      { text: "Worktrees share them", done: false },
    ],
    evidence: [
      { kind: "image", url: "https://files.example/board.png", caption: "Board on iPhone" },
      { kind: "log", url: "https://files.example/run.log", caption: "Export run log" },
    ],
    location: expect.stringMatching(new RegExp(`^\\.clankie/work/${parent.identifier}-`, "u")),
  });
  expect(parentFile?.summary).toContain("Owner-authored section stays.");
  expect(await files.readIssue?.(parent.identifier)).toMatchObject({
    ownerCheck: "Open Work, tap a file: it opens",
  });
  expect(await files.get(child.identifier)).toMatchObject({
    parent: parent.identifier,
    dependsOn: [parent.identifier],
  });
  // The imported golden keeps its Linear identity and body; its uploads, already in the
  // evidence store as links, become the file's evidence.
  const golden = await files.readIssue?.("VUH-1905");
  const source = (await f.tracker.call("get_issue", { id: "VUH-1905" })) as {
    description: string;
    url: string;
    links: { url: string; title: string }[];
  };
  expect(source.links.length).toBeGreaterThan(0);
  expect(String(golden!.description).startsWith(`\n${source.description.trim()}\n`)).toBe(true);
  expect((await files.get("VUH-1905"))?.evidence).toEqual(
    source.links.map((link) => ({ kind: "link", url: link.url, caption: link.title })),
  );
  expect(await readFile(join(f.app.repo, golden!.url as string), "utf8")).toContain(`source: ${source.url}`);

  // A re-run is idempotent: nothing duplicated, nothing rewritten.
  const before = await Promise.all(
    (await mdFiles(folder)).map((name) => readFile(join(folder, name), "utf8")),
  );
  const again = await f.work("export", "--project", "app", "--to", "markdown");
  expect(again.body.counts).toEqual({ create: 0, update: 0, unchanged: 4, kept: 0, closedSkipped: 5 });
  expect(again.body.gitignore.action).toBe("present");
  expect(
    await Promise.all((await mdFiles(folder)).map((name) => readFile(join(folder, name), "utf8"))),
  ).toEqual(before);

  // An agent edits one file through the files backend; the tracker moves on meanwhile.
  await files.update(child.identifier, { status: "in_progress" });
  const edited = await readFile(join(f.app.repo, (await files.get(child.identifier))!.location), "utf8");
  await save({ id: parent.id, title: "Issue files replace the Work board and Mailbox" });
  await save({ id: child.id, state: "Canceled" });
  await save({ id: "VUH-1907", state: "Canceled" });
  const third = await f.work("export", "--project", "app", "--to", "markdown");
  expect(third.body.counts).toEqual({ create: 0, update: 2, unchanged: 1, kept: 1, closedSkipped: 5 });
  expect(third.body.items.find((item: { id: string }) => item.id === child.identifier)).toMatchObject({
    action: "kept",
    reason: "This file changed since it was exported; left as it is.",
  });
  // The changed file is left byte for byte; untouched files follow the tracker, a close included.
  expect(await readFile(join(f.app.repo, (await files.get(child.identifier))!.location), "utf8")).toBe(
    edited,
  );
  expect(await files.get(parent.identifier)).toMatchObject({
    title: "Issue files replace the Work board and Mailbox",
  });
  expect(await files.get("VUH-1907")).toMatchObject({ status: "canceled" });
  // A closed item never gets a new file.
  expect(await files.get(done.identifier)).toBeUndefined();

  // Writers in the checkout and its worktree share one lock: concurrent edits of one file both land.
  const main = createFilesBackend({ root: f.app.repo, directory: ".clankie/work", kind: "markdown" });
  await Promise.all(
    Array.from({ length: 6 }, (_, n) =>
      (n % 2 === 0 ? main : files).update("VUH-1905", { addCriteria: [`Concurrent edit ${String(n)}`] }),
    ),
  );
  expect(
    (await files.get("VUH-1905"))!.criteria.filter((criterion) => criterion.text.startsWith("Concurrent")),
  ).toHaveLength(6);

  // Step two, the existing path: select the files as the project's tracker.
  const authorize = async () => true as const;
  const settingsApp = new Hono().route(
    "/",
    createWorkTrackerSettingsRoutes(authorize, f.settings, { tracker: f.tracker }),
  );
  const selection = { backend: "markdown", directory: ".clankie/work" };
  const post = async (body: unknown) =>
    (await settingsApp.request(WORK_TRACKER_SETTINGS_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })) as Response;
  const preview = (await (await post({ action: "preview", projectId: "app", selection })).json()) as {
    revision: string;
  };
  const applied = await post({
    action: "apply",
    projectId: "app",
    selection,
    expectedRevision: preview.revision,
    confirmRetainItems: true,
  });
  expect(applied.status).toBe(200);
  expect(await readConvention(f.app.repo)).toMatchObject(selection);
  const listed = await f.service.handle({ action: "list", repo: f.app.repo }, true);
  expect("items" in listed ? listed.items.map((item) => item.id).sort() : []).toEqual(
    ["VUH-1905", "VUH-1907", parent.identifier, child.identifier].sort(),
  );
  // The built-in tracker was only read: the export added nothing there.
  const all = (await f.tracker.call("list_issues", { project: f.projectId, limit: 100 })) as {
    issues: unknown[];
  };
  expect(all.issues).toHaveLength(9);
});

it("exports a Linear-backed project and refuses a project on Auto", async () => {
  const f = await fixture();
  const save = async (args: Record<string, unknown>) =>
    (await f.service.callTracker("save_issue", args, { repo: f.linear.repo, local: true, actor: owner })) as {
      identifier: string;
    };
  const open = await save({ team: "VUH", title: "Linear item still open", state: "In Progress" });
  await save({ team: "VUH", title: "Linear item dropped", state: "Canceled" });
  const exported = (
    await f.workIn(f.linear.worktree, "export", "--project", "linear-app", "--to", "markdown")
  ).body;
  expect(exported).toMatchObject({
    ready: true,
    source: { backend: "linear", linear: { team: "VUH", project: "Clankie" } },
    counts: { create: 1, closedSkipped: 1 },
  });
  const files = createFilesBackend({ root: f.linear.worktree, directory: ".clankie/work", kind: "markdown" });
  expect((await files.list()).map((item) => [item.id, item.title, item.status])).toEqual([
    [open.identifier, "Linear item still open", "in_progress"],
  ]);
  expect(await git(f.linear.repo, "status", "--porcelain")).toBe("");

  // Decision 3: a project Clankie runs on Auto keeps the built-in tracker. Nothing is written.
  for (const dryRun of [true, false]) {
    const refused = await f.work(
      "export",
      "--project",
      "auto-app",
      "--to",
      "markdown",
      ...(dryRun ? ["--dry-run"] : []),
    );
    expect(refused.ok).toBe(dryRun);
    expect(refused.body).toMatchObject({
      ready: false,
      refusals: [expect.stringContaining("Auto App is on Auto")],
    });
  }
  expect(existsSync(join(f.auto.repo, ".clankie/work"))).toBe(false);
  expect((await f.work("export", "--project", "nope", "--to", "markdown")).body.refusals).toEqual([
    "No project nope.",
  ]);
  await expect(f.work("export", "--project", "app", "--to", "github")).rejects.toThrow(/--to markdown/u);
});
