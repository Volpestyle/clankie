import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  FileCredentialStore,
  mintOperatorToken,
  OPERATOR_CREDENTIAL_PROVIDER_ID,
} from "@clankie/credential-broker";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { SettingsStore } from "@clankie/settings";
import { createLocalTracker, writeConvention } from "@clankie/work-items";
import { runProjectSettingsCommand } from "../../tui/src/command/project-settings.ts";
import { projectWorkRepoId } from "../src/project-work-items.ts";
import { createProjectRoutes } from "../src/project-routes.ts";
import { createWorkItemsService } from "../src/work-items.ts";

it("edits the exact built-in UUID through project settings CLI and withholds unavailable bindings", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tracker-settings-")));
  try {
    const workspace = join(root, "work");
    await mkdir(workspace);
    await writeConvention(workspace, {
      schemaVersion: 1,
      backend: "default",
      decidedBy: "owner",
      decidedAt: "2026-10-13T00:00:00Z",
    });
    const settings = new SettingsStore(join(root, "settings.json"));
    await settings.update((current) => ({
      ...current,
      projects: ProjectsSettingsSchema.parse({
        projects: [
          {
            id: "garden",
            name: "Garden",
            workspaces: [{ id: "repo", machineId: "local", platform: "posix", path: workspace }],
            trackerRef: { workspaceId: "repo", path: ".clankie/tracking.json" },
          },
          {
            id: "unbound",
            name: "Unbound",
            workspaces: [{ id: "repo", machineId: "local", platform: "posix", path: workspace }],
            trackerRef: { workspaceId: "repo", path: ".clankie/tracking.json" },
          },
        ],
      }),
    }));
    const trackerDirectory = join(root, "tracker");
    const tracker = createLocalTracker({ directory: trackerDirectory });
    const storeFile = join(trackerDirectory, "tracker.json");
    const project = (await tracker.call("save_project", { name: "Garden", addTeams: ["LOCAL"] })) as {
      id: string;
    };
    const credentials = new FileCredentialStore(join(root, "credentials.json"));
    const token = mintOperatorToken();
    await credentials.set(OPERATOR_CREDENTIAL_PROVIDER_ID, { type: "api", key: token });
    let owner = true;
    let beforeCommit: (() => Promise<void>) | undefined;
    const routes = createProjectRoutes(
      async (request) =>
        owner && request.headers.get("authorization") === `Bearer ${token}` ? true : "forbidden",
      {
        load: () => settings.load(),
        update: (mutate, guard) =>
          settings.update(mutate, async () => {
            await beforeCommit?.();
            await guard?.();
          }),
      },
      {
        trackerStoreId: () => tracker.storeId(),
        trackerProjectExists: async (id) =>
          ((await tracker.call("get_project", { query: id })) as { id: string }).id === id,
      },
    );
    const client = {
      env: { CLANKIE_OPERATOR_TOKEN: token },
      operatorCredentialStore: credentials,
      host: "http://clankie.test",
      fetchImpl: (async (url, init) => routes.request(new Request(String(url), init))) as typeof fetch,
    };
    const work = createWorkItemsService({
      stateDirectory: root,
      localMachineId: "local",
      projects: async () => (await settings.load()).projects,
    });
    const bind = (value: string, projectId = "garden") =>
      runProjectSettingsCommand(["settings", projectId, "--tracker-project", value], client);
    await expect(bind("Garden")).rejects.toThrow();
    await expect(bind(randomUUID())).rejects.toThrow("refused (400)");
    expect(await bind(project.id)).toMatchObject({ trackerProjectId: project.id });
    await expect(bind(project.id, "unbound")).rejects.toThrow("Project settings changed");
    const repos = (await work.handle({ action: "repos" }, true)) as { repos: Record<string, unknown>[] };
    expect(repos.repos.find((repo) => repo.projectId === "garden")).toHaveProperty(
      "trackerProjectId",
      project.id,
    );
    expect(repos.repos.find((repo) => repo.projectId === "unbound")).not.toHaveProperty("trackerProjectId");
    expect(
      (
        await routes.request("/v1/operator/projects", {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);
    const verifiedSettings = await settings.load();
    await settings.update((current) => ({
      ...current,
      projects: {
        ...current.projects,
        projects: current.projects.projects.map((entry) =>
          entry.id === "unbound" ? { ...entry, trackerProjectId: project.id } : entry,
        ),
      },
    }));
    const duplicated = (await work.handle({ action: "repos" }, true)) as {
      repos: Record<string, unknown>[];
    };
    for (const repo of duplicated.repos) {
      expect(repo).toHaveProperty("unavailable");
      expect(repo).not.toHaveProperty("trackerProjectId");
    }
    await settings.update(() => verifiedSettings);
    await rename(storeFile, `${storeFile}.missing`);
    const missing = (await work.handle({ action: "repos" }, true)) as {
      repos: Record<string, unknown>[];
    };
    expect(missing.repos.find((repo) => repo.projectId === "garden")).toHaveProperty("unavailable");
    expect(missing.repos.find((repo) => repo.projectId === "garden")).not.toHaveProperty("trackerProjectId");
    expect(missing.repos.find((repo) => repo.projectId === "unbound")).not.toHaveProperty("unavailable");
    expect(await settings.load()).toEqual(verifiedSettings);
    await rename(`${storeFile}.missing`, storeFile);
    const legacy = await routes.request("/v1/operator/projects", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(
      ((await legacy.json()) as { settings: { projects: Record<string, unknown>[] } }).settings.projects[0],
    ).not.toHaveProperty("trackerProjectId");
    // A clear is owner-reviewed and does not need the old tracker to remain available.
    await bind("clear");
    const unboundSettings = await settings.load();
    beforeCommit = async () => {
      owner = false;
    };
    await expect(bind(project.id)).rejects.toThrow("Project settings changed");
    expect(await settings.load()).toEqual(unboundSettings);
    owner = true;
    beforeCommit = async () => {
      const store = JSON.parse(await readFile(storeFile, "utf8"));
      store.storeId = randomUUID();
      await writeFile(`${storeFile}.replacement`, JSON.stringify(store));
      await rename(`${storeFile}.replacement`, storeFile);
    };
    await expect(bind(project.id)).rejects.toThrow("Project settings changed");
    expect(await settings.load()).toEqual(unboundSettings);
    beforeCommit = undefined;
    await bind(project.id);
    const boundSettings = await settings.load();
    const replacement = createLocalTracker({ directory: join(root, "replacement") });
    await replacement.call("save_project", { name: project.id, addTeams: ["LOCAL"] });
    await rename(join(root, "replacement", "tracker.json"), storeFile);
    const unavailable = (await work.handle({ action: "repos" }, true)) as {
      repos: Record<string, unknown>[];
    };
    expect(unavailable.repos.find((repo) => repo.projectId === "garden")).toHaveProperty("unavailable");
    expect(unavailable.repos.find((repo) => repo.projectId === "garden")).not.toHaveProperty(
      "trackerProjectId",
    );
    expect(unavailable.repos.find((repo) => repo.projectId === "unbound")).not.toHaveProperty("unavailable");
    expect(await settings.load()).toEqual(boundSettings);
    await bind("clear");
    expect(
      (await settings.load()).projects.projects.find((entry) => entry.id === "garden"),
    ).not.toHaveProperty("trackerProjectId");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("publishes bound tracker writes without lock reentry and refuses a vanished project before publication", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tracker-publication-")));
  try {
    const workspace = join(root, "garden");
    await mkdir(workspace);
    await writeConvention(workspace, {
      schemaVersion: 1,
      backend: "builtin",
      decidedBy: "owner",
      decidedAt: "2026-10-13T00:00:00Z",
    });
    const directory = join(root, "tracker");
    const storeFile = join(directory, "tracker.json");
    let removeProject = false;
    let externalBytes: string | undefined;
    const tracker = createLocalTracker({
      directory,
      assertIssueWrite: (issue) => {
        if (!removeProject) return;
        removeProject = false;
        // A real external file change after preparation keeps the same store identity.
        const saved = JSON.parse(readFileSync(storeFile, "utf8"));
        saved.projects = saved.projects.filter((entry: { id: string }) => entry.id !== issue.projectId);
        externalBytes = JSON.stringify(saved);
        writeFileSync(storeFile, externalBytes);
      },
    });
    const project = (await tracker.call("save_project", { name: "Garden", addTeams: ["LOCAL"] })) as {
      id: string;
    };
    const settings = ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "garden",
          name: "Garden",
          workspaces: [{ id: "repo", machineId: "local", platform: "posix", path: workspace }],
          trackerRef: { workspaceId: "repo", path: ".clankie/tracking.json" },
          trackerProjectId: project.id,
        },
      ],
    });
    const work = createWorkItemsService({
      stateDirectory: root,
      localMachineId: "local",
      projects: async () => settings,
      builtInTracker: () => tracker,
    });
    const repo = projectWorkRepoId("garden");
    const issue = (await work.callTracker(
      "save_issue",
      { title: "Published once" },
      { repo, local: true },
    )) as {
      id: string;
    };
    expect(await tracker.call("get_issue", { id: issue.id })).toMatchObject({ title: "Published once" });
    const storeId = await tracker.storeId();
    expect(await tracker.projectStoreId(project.id)).toBe(storeId);
    expect(await tracker.projectStoreId("Garden")).toBeUndefined();
    let dispatched = false;
    removeProject = true;
    await expect(
      work.callTracker(
        "save_issue",
        { id: issue.id, title: "Must not publish" },
        {
          repo,
          local: true,
          onDispatch: () => {
            dispatched = true;
          },
        },
      ),
    ).rejects.toThrow("Tracker store changed before commit");
    expect(dispatched).toBe(false);
    expect(await readFile(storeFile, "utf8")).toBe(externalBytes);
    expect(await tracker.storeId()).toBe(storeId);
    expect(await tracker.projectStoreId(project.id)).toBeUndefined();
    const corrupt = JSON.parse(externalBytes!);
    corrupt.version = -1;
    await writeFile(storeFile, JSON.stringify(corrupt));
    await expect(tracker.projectStoreId(project.id)).rejects.toThrow(
      "Invalid or unsupported local tracker store",
    );
    const missingDirectory = join(root, "missing");
    expect(
      await createLocalTracker({ directory: missingDirectory }).projectStoreId(project.id),
    ).toBeUndefined();
    await expect(stat(missingDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
