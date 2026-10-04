import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { SettingsStore, projectsRevision } from "@clankie/settings";
import { PROJECT_CREATE_SETTINGS_PATH, ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { createProjectRoutes } from "../src/project-routes.ts";

const cleanups: string[] = [];
afterEach(async () => {
  for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true });
});
const convention = {
  schemaVersion: 1,
  backend: "github",
  github: { repo: "fixture/repo" },
  decidedBy: "owner",
  decidedAt: "2026-10-04T00:00:00Z",
};
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "project-create-")));
  cleanups.push(root);
  const workspace = join(root, "new");
  const existing = join(root, "existing");
  await mkdir(workspace);
  await mkdir(existing);
  const store = new SettingsStore(join(root, "settings.json"));
  await store.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "existing",
          name: "Existing",
          workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: existing }],
          workerCap: 7,
          roles: [{ role: "builder", concurrencyCap: 2 }],
        },
      ],
      assignments: [{ projectId: "existing", personaId: "fixture-worker", role: "builder" }],
    }),
  }));
  let authorized: true | "forbidden" | "authentication_required" = true;
  let race: (() => Promise<void>) | undefined;
  const settings = {
    load: () => store.load(),
    update: (mutate: Parameters<SettingsStore["update"]>[0], guard?: () => Promise<void>) =>
      store.update(mutate, async () => {
        await race?.();
        await guard?.();
      }),
  };
  const app = createProjectRoutes(async () => authorized, settings);
  const command = async (patch = {}) => ({
    projectId: "new",
    name: "New",
    workspacePath: workspace,
    expectedRevision: projectsRevision((await store.load()).projects),
    ...patch,
  });
  const request = async (input: unknown) =>
    app.request(PROJECT_CREATE_SETTINGS_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  const tracking = join(workspace, ".clankie", "tracking.json");
  const tracker = async () => {
    await mkdir(join(workspace, ".clankie"));
    await writeFile(tracking, JSON.stringify(convention));
  };
  return {
    root,
    workspace,
    existing,
    store,
    app,
    command,
    request,
    tracker,
    tracking,
    deny: (value: typeof authorized = "forbidden") => {
      authorized = value;
    },
    race: (value: () => Promise<void>) => {
      race = value;
    },
  };
}

it("creates only the reviewed local project, preserving zero/inherited caps and unrelated settings", async () => {
  const f = await fixture();
  const before = await f.store.load();
  const result = await f.request(
    await f.command({
      roles: [
        {
          role: "Sound Designer",
          harness: "codex",
          model: "fixture/model",
          effort: "high",
          concurrencyCap: null,
        },
        { role: "builder", concurrencyCap: 0 },
      ],
      workerCap: 0,
      fleet: { size: "max", models: "efficient" },
    }),
  );
  expect(result.status).toBe(201);
  const saved = await f.store.load();
  const project = saved.projects.projects.at(-1)!;
  expect(project).toMatchObject({
    id: "new",
    name: "New",
    workspaces: [{ id: "primary", machineId: "local", platform: "posix", path: f.workspace }],
    workerCap: 0,
    fleet: { size: "max", models: "efficient" },
    grants: [],
    worktreeRoots: [],
    roles: [
      { role: "Sound Designer", harness: "codex", model: "fixture/model", effort: "high" },
      { role: "builder", concurrencyCap: 0 },
    ],
  });
  expect(project.roles[0]).not.toHaveProperty("concurrencyCap");
  expect({
    ...saved,
    projects: { ...saved.projects, projects: saved.projects.projects.slice(0, -1) },
  }).toEqual(before);
  expect(await result.json()).toEqual({
    settings: saved.projects,
    revision: projectsRevision(saved.projects),
  });
});
it.each([undefined, null])(
  "inherited numeric caps stay absent independently of solo preference (%s)",
  async (workerCap) => {
    const f = await fixture();
    expect(
      (await f.request(await f.command({ workerCap, fleet: { size: "solo" }, trackerRef: null }))).status,
    ).toBe(201);
    const project = (await f.store.load()).projects.projects.at(-1)!;
    expect(project).not.toHaveProperty("workerCap");
    expect(project.roles).toEqual([]);
    expect(project).not.toHaveProperty("trackerRef");
  },
);
it.each(["forbidden", "authentication_required"] as const)(
  "requires existing owner authorization: %s",
  async (reason) => {
    const f = await fixture();
    const before = await readFile(f.store.path);
    f.deny(reason);
    expect((await f.request(await f.command())).status).toBe(reason === "forbidden" ? 403 : 401);
    expect(await readFile(f.store.path)).toEqual(before);
  },
);
it.each([
  { machineId: "pc" },
  { platform: "windows" },
  { workspaces: [] },
  { worktreeRoots: [] },
  { grants: [] },
  { assignments: [] },
  { proof: {} },
  { roles: [{ role: "builder", concurrencyCap: -1 }] },
  { trackerRef: { workspaceId: "existing", path: ".clankie/tracking.json" } },
  { fleet: { size: "six" } },
  { workerCap: 1.5 },
])("rejects fields outside creation authority: %j", async (patch) => {
  const f = await fixture();
  const before = await readFile(f.store.path);
  expect((await f.request(await f.command(patch))).status).toBe(400);
  expect(await readFile(f.store.path)).toEqual(before);
});
it.each(["duplicate", "stale", "overlap", "parent", "alias", "file", "duplicate-role"])(
  "refuses %s without settings mutation",
  async (mode) => {
    const f = await fixture();
    const before = await readFile(f.store.path);
    const patch: Record<string, unknown> = {};
    if (mode === "duplicate") patch.projectId = "existing";
    if (mode === "stale") patch.expectedRevision = "a".repeat(64);
    if (mode === "overlap") patch.workspacePath = f.existing;
    if (mode === "parent") patch.workspacePath = f.root;
    if (mode === "duplicate-role") patch.roles = [{ role: "BUILDER" }, { role: "builder" }];
    if (mode === "alias") {
      const alias = join(f.root, "alias");
      await symlink(f.workspace, alias);
      patch.workspacePath = alias;
    }
    if (mode === "file") {
      const file = join(f.root, "file");
      await writeFile(file, "fixture");
      patch.workspacePath = file;
    }
    expect((await f.request(await f.command(patch))).status).toBe(409);
    expect(await readFile(f.store.path)).toEqual(before);
  },
);
it.each(["owner", "workspace-replaced", "registered-replaced", "projects", "other-settings"])(
  "commit guard refuses %s and retains any concurrent write",
  async (mode) => {
    const f = await fixture();
    const before = await f.store.load();
    let expected = before;
    f.race(async () => {
      if (mode === "owner") f.deny();
      if (mode.endsWith("replaced")) {
        const path = mode === "workspace-replaced" ? f.workspace : f.existing;
        await rename(path, path + "-old");
        await mkdir(path);
      }
      if (mode === "projects" || mode === "other-settings") {
        expected = structuredClone(before);
        if (mode === "projects") expected.projects.projects[0]!.name = "Concurrent";
        else expected.fleet = { ...expected.fleet, size: "solo" };
        await writeFile(f.store.path, JSON.stringify(expected));
      }
    });
    expect((await f.request(await f.command())).status).toBe(409);
    expect(await f.store.load()).toEqual(expected);
  },
);
it("concurrent creates with one revision never overwrite or silently upsert", async () => {
  const f = await fixture();
  const input = await f.command();
  expect((await Promise.all([f.request(input), f.request(input)])).map((x) => x.status).sort()).toEqual([
    201, 409,
  ]);
  expect((await f.store.load()).projects.projects.filter((x) => x.id === "new")).toHaveLength(1);
});
it("binds the existing convention without changing its bytes or choosing a backend", async () => {
  const f = await fixture();
  await f.tracker();
  const bytes = await readFile(f.tracking);
  expect(
    (
      await f.request(
        await f.command({ trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" } }),
      )
    ).status,
  ).toBe(201);
  expect(await readFile(f.tracking)).toEqual(bytes);
  expect((await f.store.load()).projects.projects.at(-1)!.trackerRef).toEqual({
    workspaceId: "primary",
    path: ".clankie/tracking.json",
  });
});
it.each(["missing", "malformed", "oversized", "alias", "content-change", "bytes-only", "replacement"])(
  "refuses %s tracker without writing or completing setup",
  async (mode) => {
    const f = await fixture();
    const before = await readFile(f.store.path);
    if (mode !== "missing") await f.tracker();
    if (mode === "malformed") await writeFile(f.tracking, "{}");
    if (mode === "oversized") await writeFile(f.tracking, "x".repeat(16_385));
    if (mode === "alias") {
      await rename(f.tracking, f.tracking + "-saved");
      await symlink(f.tracking + "-saved", f.tracking);
    }
    if (mode === "content-change")
      f.race(async () => {
        await writeFile(f.tracking, JSON.stringify({ ...convention, github: { repo: "fixture/other" } }));
      });
    if (mode === "bytes-only")
      f.race(async () => {
        await writeFile(f.tracking, JSON.stringify(convention, null, 2));
      });
    if (mode === "replacement")
      f.race(async () => {
        await rename(f.tracking, f.tracking + "-saved");
        await writeFile(f.tracking, JSON.stringify(convention));
      });
    const result = await f.request(
      await f.command({ trackerRef: { workspaceId: "primary", path: ".clankie/tracking.json" } }),
    );
    expect(result.status).toBe(409);
    expect(await result.json()).toEqual({
      error: ["content-change", "bytes-only", "replacement"].includes(mode)
        ? "project_create_conflict"
        : "project_tracker_unavailable",
    });
    expect(await readFile(f.store.path)).toEqual(before);
  },
);

it("rejects malformed and oversized bodies before writing a project", async () => {
  const f = await fixture();
  const before = await readFile(f.store.path);
  const malformed = await f.app.request(PROJECT_CREATE_SETTINGS_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  expect(malformed.status).toBe(400);
  expect((await f.request(await f.command({ name: "x".repeat(17_000) }))).status).toBe(413);
  expect(await readFile(f.store.path)).toEqual(before);
});
