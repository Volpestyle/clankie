import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { SettingsStore, projectsRevision } from "@clankie/settings";
import {
  ProjectsSettingsSchema,
  PROJECT_UPDATE_SETTINGS_PATH,
  type UpdateProjectSettings,
} from "@clankie/protocol/projects";
import { writeConvention } from "@clankie/work-items";
import { createProjectRoutes } from "../src/project-routes.ts";
import { createWorkItemsService, WorkRequestError } from "../src/work-items.ts";
import { projectWorkRepoId } from "../src/project-work-items.ts";
import { ProjectHires } from "../src/captain/project-hires.ts";

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "project-edit-")));
  const a = join(directory, "a");
  const b = join(directory, "b");
  await mkdir(a);
  await mkdir(b);
  for (const [path, repo] of [
    [a, "fixture/a"],
    [b, "fixture/b"],
  ] as const)
    await writeConvention(path, {
      schemaVersion: 1,
      backend: "github",
      github: { repo },
      decidedBy: "owner",
      decidedAt: "2026-10-04T00:00:00Z",
    });
  const store = new SettingsStore(join(directory, "settings.json"));
  await store.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "garden",
          name: "Garden",
          workspaces: [
            { id: "a", machineId: "local", path: a, platform: "posix" },
            { id: "b", machineId: "local", path: b, platform: "posix" },
            { id: "remote", machineId: "pc", path: a, platform: "posix" },
          ],
          trackerRef: { workspaceId: "a", path: ".clankie/tracking.json" },
          roles: [{ role: "builder", harness: "codex", model: "old-model", hireNaming: "Trees" }],
          workerCap: 4,
          labelRoleMap: [{ label: "code", role: "builder" }],
          fleet: { size: "small" },
          grants: [],
        },
        { id: "other", name: "Other" },
      ],
      assignments: [{ projectId: "garden", personaId: "worker", role: "builder" }],
    }),
  }));
  let authorized: true | "forbidden" = true;
  let checks = 0;
  let denyAt = Infinity;
  const routes = createProjectRoutes(async () => (++checks >= denyAt ? "forbidden" : authorized), store);
  const update = async (changes: UpdateProjectSettings["changes"], revision?: string) =>
    routes.request(PROJECT_UPDATE_SETTINGS_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId: "garden",
        expectedRevision: revision ?? projectsRevision((await store.load()).projects),
        changes,
      }),
    });
  return {
    directory,
    a,
    b,
    store,
    routes,
    update,
    deny: () => {
      authorized = "forbidden";
    },
    denyDuringWrite: () => {
      denyAt = checks + 2;
    },
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

it("persists validated policy edits, clears optional fields, preserves untouched settings and rejects stale/in-use/authority races", async () => {
  const f = await fixture();
  try {
    const before = await f.store.load();
    const revision = projectsRevision(before.projects);
    const response = await f.update({
      roles: [{ ...before.projects.projects[0]!.roles[0]!, model: "gpt-6-astra", concurrencyCap: 0 }],
      workerCap: null,
    });
    expect(response.status).toBe(200);
    const after = await f.store.load();
    expect(after.projects.projects[0]).toMatchObject({
      roles: [{ model: "gpt-6-astra", concurrencyCap: 0, harness: "codex", hireNaming: "Trees" }],
      fleet: { size: "small" },
      labelRoleMap: [{ label: "code", role: "builder" }],
    });
    expect(after.projects.projects[0]!.workerCap).toBeUndefined();
    expect(after.projects.projects[1]).toEqual(before.projects.projects[1]);
    expect(after.projects.assignments).toEqual(before.projects.assignments);
    expect((await f.update({ name: "stale" }, revision)).status).toBe(409);
    expect((await f.update({ roles: [{ role: "designer" }] })).status).toBe(409);
    expect(
      (await f.update({ trackerRef: { workspaceId: "missing", path: ".clankie/tracking.json" } })).status,
    ).toBe(409);
    f.denyDuringWrite();
    expect((await f.update({ name: "not authorized" })).status).toBe(409);
    expect(await f.store.load()).toEqual(after);
  } finally {
    await f.close();
  }
});

it("a saved A→B binding changes the actual existing tracker adapter, rejects stale A output and never registers or writes work", async () => {
  const f = await fixture();
  const calls: readonly string[][] = [];
  let release!: (text: string) => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const issue = (name: string) =>
    JSON.stringify([
      [
        {
          number: 1,
          title: name,
          state: "open",
          html_url: `https://github.invalid/${name}/1`,
          body: "",
          labels: [],
          assignees: [],
        },
      ],
    ]);
  const gh = vi.fn(async (args: readonly string[]) => {
    (calls as string[][]).push([...args]);
    const parentPath = args.find((arg) => arg.endsWith("/parent"));
    if (parentPath !== undefined) {
      expect(args[args.indexOf("-X") + 1]).toBe("GET");
      const match = /^repos\/fixture\/(a|b)\/issues\/1\/parent$/u.exec(parentPath);
      expect(match).not.toBeNull();
      return JSON.stringify({
        number: 2,
        repository_url: `https://api.github.com/repos/fixture/${match![1]!}`,
      });
    }
    if (args.includes("--paginate") && args.some((arg) => arg.includes("fixture/a"))) {
      entered();
      return new Promise<string>((r) => {
        release = r;
      });
    }
    const issuePath = args.find((arg) => /^repos\/fixture\/(a|b)\/issues\/1$/u.test(arg));
    if (issuePath !== undefined) {
      expect(args[args.indexOf("-X") + 1]).toBe("GET");
      const name = issuePath.includes("fixture/a") ? "A" : "B";
      return JSON.stringify(JSON.parse(issue(name))[0][0]);
    }
    return issue("B");
  });
  const run = vi.fn(async () => {
    throw new Error("Discovery must never run");
  });
  const githubToken = vi.fn(async () => undefined);
  const service = createWorkItemsService({
    stateDirectory: f.directory,
    projects: async () => (await f.store.load()).projects,
    localMachineId: "local",
    gh,
    run,
    githubToken,
  });
  try {
    const ref = projectWorkRepoId("garden");
    expect(await service.handle({ action: "repos" }, false)).toMatchObject({
      repos: [{ id: ref, projectId: "garden", root: f.a, backend: "github" }],
    });
    const old = service.handle({ action: "list", repo: ref }, false);
    const oldResult = old.catch((error) => error);
    await started;
    expect(
      (await f.update({ trackerRef: { workspaceId: "b", path: ".clankie/tracking.json" } })).status,
    ).toBe(200);
    release(issue("A"));
    expect(await oldResult).toMatchObject({ code: "backend_unavailable" });
    expect(await service.handle({ action: "list", repo: ref }, false)).toMatchObject({
      repo: { root: f.b },
      items: [{ title: "B", parent: "#2" }],
    });
    expect(gh).toHaveBeenCalledTimes(8);
    expect(calls.filter((args) => args.includes("--paginate"))).toHaveLength(2);
    expect(calls.flatMap((args) => args.filter((arg) => arg.endsWith("/parent")))).toEqual([
      "repos/fixture/a/issues/1/parent",
      "repos/fixture/a/issues/1/parent",
      "repos/fixture/b/issues/1/parent",
      "repos/fixture/b/issues/1/parent",
    ]);
    expect(
      calls.filter((args) => args.some((arg) => /^repos\/fixture\/(a|b)\/issues\/1$/u.test(arg))),
    ).toHaveLength(2);
    expect(calls.every((args) => args.includes("--paginate") || args[args.indexOf("-X") + 1] === "GET")).toBe(
      true,
    );
    expect(githubToken).toHaveBeenCalledTimes(2);
    for (const action of ["discover", "init", "create", "update", "attach"] as const) {
      await expect(
        service.handle({ action, repo: ref } as Parameters<typeof service.handle>[0], true),
      ).rejects.toMatchObject({ code: "invalid" });
    }
    expect(
      (await f.update({ trackerRef: { workspaceId: "remote", path: ".clankie/tracking.json" } })).status,
    ).toBe(200);
    expect(await service.handle({ action: "repos" }, false)).toMatchObject({
      repos: [{ unavailable: expect.any(String) }],
    });
    await expect(service.handle({ action: "list", repo: ref }, false)).rejects.toMatchObject({
      code: "backend_unavailable",
    });
    expect(gh).toHaveBeenCalledTimes(8); // Remote uses the SAME local path; it must still never read it.
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(join(f.directory, "work-repos.json"))).toBe(false);
    expect(existsSync(join(f.a, ".clankie/work"))).toBe(false);
    await writeFile(join(f.b, ".clankie/tracking.json"), "{}");
    expect(
      (await f.update({ trackerRef: { workspaceId: "b", path: ".clankie/tracking.json" } })).status,
    ).toBe(200);
    expect(await service.handle({ action: "repos" }, false)).toMatchObject({
      repos: [{ unavailable: expect.any(String) }],
    });
  } finally {
    await f.close();
  }
});

it("saved role model/effort and caps govern actual hire admission without starting an agent", async () => {
  const f = await fixture();
  try {
    const hires = new ProjectHires(join(f.directory, "fixture-hires.json"));
    const request = {
      schemaVersion: 1 as const,
      workingDirectory: f.a,
      title: "Fixture",
      role: "builder",
    };
    expect((await f.update({ workerCap: 0 })).status).toBe(200);
    let current = (await f.store.load()).projects;
    expect(() => hires.reserve(current, "garden", request)).toThrow(/cap|limit/iu);
    expect(
      (
        await f.update({
          workerCap: 1,
          roles: [
            { ...current.projects[0]!.roles[0]!, model: "gpt-6-astra", effort: "high", concurrencyCap: 1 },
          ],
        })
      ).status,
    ).toBe(200);
    current = (await f.store.load()).projects;
    expect(hires.reserve(current, "garden", request).request).toMatchObject({
      harness: "codex",
      model: "gpt-6-astra",
      effort: "high",
    });
    expect(() => hires.reserve(current, "garden", { ...request, workingDirectory: f.b })).toThrow(
      /allows 1 running agents/u,
    );
  } finally {
    await f.close();
  }
});

it("keeps registered repos alongside bound projects and returns typed overflow without trimming or changing the registry", async () => {
  const f = await fixture();
  try {
    const registry = join(f.directory, "work-repos.json");
    const entries = Array.from({ length: 49 }, (_, n) => ({
      id: `legacy-${n}`,
      name: `Legacy ${n}`,
      path: f.a,
    }));
    await writeFile(registry, JSON.stringify({ repos: entries }));
    const service = createWorkItemsService({
      stateDirectory: f.directory,
      projects: async () => (await f.store.load()).projects,
      localMachineId: "local",
    });
    const listed = await service.handle({ action: "repos" }, false);
    expect("repos" in listed && listed.repos).toHaveLength(50);
    expect("repos" in listed && listed.repos.some((repo) => repo.id === "legacy-48")).toBe(true);
    entries.push({ id: "legacy-49", name: "Legacy 49", path: f.a });
    const saved = JSON.stringify({ repos: entries });
    await writeFile(registry, saved);
    await expect(service.handle({ action: "repos" }, false)).rejects.toMatchObject({
      code: "result_too_large",
    });
    expect(await readFile(registry, "utf8")).toBe(saved);
  } finally {
    await f.close();
  }
});

it("rejects forbidden project fields and oversized bodies before any settings mutation", async () => {
  const f = await fixture();
  try {
    const before = await f.store.load();
    const request = (changes: unknown) =>
      f.routes.request(PROJECT_UPDATE_SETTINGS_PATH, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          projectId: "garden",
          expectedRevision: projectsRevision(before.projects),
          changes,
        }),
      });
    expect((await request({ grants: [] })).status).toBe(400);
    expect((await request({ name: "x".repeat(17 * 1024) })).status).toBe(413);
    expect(await f.store.load()).toEqual(before);
  } finally {
    await f.close();
  }
});

it("preserves a tracker adapter overflow as a typed bounded failure without exposing adapter details", async () => {
  const f = await fixture();
  try {
    const service = createWorkItemsService({
      stateDirectory: f.directory,
      projects: async () => (await f.store.load()).projects,
      localMachineId: "local",
      gh: async () => {
        throw new WorkRequestError("result_too_large", "private adapter detail");
      },
    });
    await expect(
      service.handle({ action: "list", repo: projectWorkRepoId("garden") }, false),
    ).rejects.toMatchObject({
      code: "result_too_large",
      message: "This project’s work is too large to read at once.",
    });
  } finally {
    await f.close();
  }
});
