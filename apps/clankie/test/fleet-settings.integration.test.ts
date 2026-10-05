import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { ClankieApiClient } from "../../../packages/api-client/src/index.ts";
import {
  ProjectsSettingsSchema,
  FleetSettingsSnapshotSchema,
  FleetSettingsContextSchema,
  PROJECTS_PATH,
  PROJECT_UPDATE_SETTINGS_PATH,
} from "@clankie/protocol";
import {
  SettingsStore,
  projectsRevision,
  observeLocalProjectWorktreeRoot,
  addProjectWorktreeRoot,
} from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain } from "../src/captain/port.ts";
import { ExecutionConnections } from "../src/herdr-session.ts";

const exec = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fleet-settings-api-")));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "repo");
  const other = join(root, "other");
  await mkdir(cwd);
  await mkdir(other);
  const settings = new SettingsStore(join(root, "settings.json"));
  await settings.update((current) => ({
    ...current,
    machines: [{ id: "pc", ssh: "fixture.invalid", shell: "posix", aliases: [] }],
    execution: {
      connections: [
        {
          id: "pc-work",
          machine: "pc",
          kind: "herdr",
          session: "work",
          ssh: { host: "fixture.invalid", shell: "posix" },
          enabled: true,
          capabilities: ["code"],
        },
      ],
    },
    projects: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "garden",
          name: "Garden",
          workspaces: [{ id: "repo", machineId: "local", platform: "posix", path: cwd }],
          autonomy: { fleet: { closure: "owner", machineSetup: "owner" } },
        },
      ],
    }),
  }));
  let authorized = true;
  let remoteHealthy = true;
  let revokeAt = Infinity;
  let authCalls = 0;
  const prepared: Array<{ id: string; options: { codexSourceSetup?: string } }> = [];
  const refreshed: string[] = [];
  let refreshCalls = 0;
  const refreshHooks: { beforeRemote?: (() => Promise<void>) | undefined } = {};
  const binding = { runtime: "external" as const, session: "default", socketPath: join(root, "herdr.sock") };
  const runtimes = new ExecutionConnections({
    settings,
    primary: { binding: () => binding, status: () => "healthy" },
    fleetRun: () => async () => {
      if (!remoteHealthy) throw new Error("Fixture runtime is disconnected");
      return JSON.stringify({ result: { snapshot: { workspaces: [] } } });
    },
  });
  const app = await createClankieApp({
    captain: createStubCaptain(),
    settings,
    runtimes,
    herdrBinding: () => binding,
    authenticateOperator: async (request) =>
      request.headers.get("authorization") === "Bearer owner" && authorized && ++authCalls < revokeAt
        ? { operatorId: "owner" }
        : undefined,
    prepareFleet: async (id, options) => {
      prepared.push({ id, options });
      return { machine: "pc" };
    },
    refreshHarnesses: async (authority) => {
      refreshCalls++;
      await authority.authorizeSetup("local");
      refreshed.push("local");
      const target = (await settings.load()).execution.connections.find((entry) => entry.id === "pc-work")!;
      await refreshHooks.beforeRemote?.();
      await authority.authorizeSetup("pc-work", { id: target.id, session: target.session, ssh: target.ssh! });
      refreshed.push("pc-work");
      return { ok: true, local: [], fleets: [], notices: { state: "announced" } };
    },
  });
  cleanup.push(async () => {
    await app.close();
  });
  const fetchImpl = (async (input, init) =>
    app.app.request(new Request(String(input), init))) as typeof fetch;
  const client = new ClankieApiClient({ baseUrl: "http://localhost", operatorToken: "owner", fetchImpl });
  const request = (path: string, body?: unknown) =>
    app.app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer owner", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return {
    root,
    cwd,
    other,
    settings,
    app,
    client,
    request,
    prepared,
    refreshed,
    refreshHooks,
    refreshCalls: () => refreshCalls,
    revoke: () => {
      authorized = false;
    },
    revokeDuringWrite: () => {
      revokeAt = authCalls + 2;
    },
    disconnect: () => {
      remoteHealthy = false;
    },
  };
}

it("persists public fleet controls through the owner API/client and fences stale or revoked writes without changing unrelated settings", async () => {
  const f = await fixture();
  const before = await f.settings.load();
  const original = await f.client.fleetSettings();
  expect(original.fleet).toEqual({ size: "max", models: "optimal", closure: "lead", machineSetup: "lead" });
  const updated = FleetSettingsSnapshotSchema.parse(
    await f.client.updateFleetSettings({
      schemaVersion: 1,
      expectedRevision: original.revision,
      changes: { size: "small", models: "efficient", closure: "owner", machineSetup: "owner" },
    }),
  );
  expect(updated.fleet).toEqual({
    size: "small",
    models: "efficient",
    closure: "owner",
    machineSetup: "owner",
  });
  const saved = await new SettingsStore(f.settings.path).load();
  expect(saved.autonomy.fleet).toEqual({ closure: "owner", machineSetup: "owner" });
  expect(saved.projects).toEqual(before.projects);
  expect(saved.fleet.tools).toBe(before.fleet.tools);
  await expect(
    f.client.updateFleetSettings({
      schemaVersion: 1,
      expectedRevision: original.revision,
      changes: { closure: "lead" },
    }),
  ).rejects.toThrow("409");
  f.revokeDuringWrite();
  await expect(
    f.client.updateFleetSettings({
      schemaVersion: 1,
      expectedRevision: updated.revision,
      changes: { machineSetup: "lead" },
    }),
  ).rejects.toThrow("409");
  expect(await f.settings.load()).toEqual(saved);
});

it("gates explicit linked refresh with canonical current source policy, per-target links and live operator authority", async () => {
  const f = await fixture();
  const path = "/v1/harness-refresh";
  expect(
    (await f.app.app.request(path, { method: "POST", headers: { authorization: "Bearer owner" } })).status,
  ).toBe(400);
  expect((await f.request(path, { workingDirectory: f.cwd })).status).toBe(403);
  expect(f.refreshCalls()).toBe(0);
  expect(
    (await f.request(path, { workingDirectory: f.cwd, projectId: "garden", ownerApproved: true })).status,
  ).toBe(200);
  expect(f.refreshed).toEqual(["local", "pc-work"]);
  for (const input of [
    { workingDirectory: f.cwd, projectId: "other", ownerApproved: true },
    { workingDirectory: join(f.root, "missing"), ownerApproved: true },
  ])
    expect((await f.request(path, input)).status).toBe(409);
  expect(
    (
      await f.request(path, {
        workingDirectory: f.cwd,
        ownerApproved: true,
        codexSourceSetup: "/not-a-refresh-approval",
      })
    ).status,
  ).toBe(400);
  expect(f.refreshCalls()).toBe(1);
  await f.settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: current.projects.projects.map((project) => ({
        ...project,
        autonomy: { fleet: { machineSetup: "lead" } },
      })),
    }),
  }));
  expect((await f.request(path, { workingDirectory: f.cwd })).status).toBe(200);
  f.disconnect();
  const refreshedBefore = f.refreshed.length;
  const disconnected = await f.request(path, { workingDirectory: f.cwd });
  expect(disconnected.status).toBe(403);
  expect(await disconnected.json()).toEqual({ error: "machine_setup_link_required" });
  expect(f.refreshed.slice(refreshedBefore)).toEqual(["local"]);
  expect((await f.request(path, { workingDirectory: f.cwd, ownerApproved: true })).status).toBe(200);
  f.refreshHooks.beforeRemote = async () => {
    await f.settings.update((current) => ({
      ...current,
      projects: ProjectsSettingsSchema.parse({
        projects: current.projects.projects.map((project) => ({
          ...project,
          autonomy: { fleet: { machineSetup: "owner" } },
        })),
      }),
    }));
  };
  const changed = await f.request(path, { workingDirectory: f.cwd });
  expect(changed.status).toBe(403);
  expect(await changed.json()).toEqual({ error: "machine_setup_owner_approval_required" });
  f.refreshHooks.beforeRemote = async () => {
    await f.settings.update((current) => ({
      ...current,
      machines: current.machines.map((machine) => ({ ...machine, ssh: "changed-fixture.invalid" })),
      agentHosts: {
        connections: current.agentHosts.connections.map((host) => ({
          ...host,
          ssh: "changed-fixture.invalid",
        })),
      },
      execution: {
        connections: current.execution.connections.map((connection) => ({
          ...connection,
          ssh: { ...connection.ssh!, host: "changed-fixture.invalid" },
        })),
      },
    }));
  };
  const retargeted = await f.request(path, { workingDirectory: f.cwd, ownerApproved: true });
  expect(retargeted.status).toBe(409);
  expect(await retargeted.json()).toEqual({
    error: "harness_refresh_refused",
    detail: "Machine setup target changed",
  });
  f.refreshHooks.beforeRemote = async () => {
    f.revoke();
  };
  expect((await f.request(path, { workingDirectory: f.cwd, ownerApproved: true })).status).toBe(403);
});

it("opts new project clients into current autonomy while preserving legacy wire shapes and the revision of full policy", async () => {
  const f = await fixture();
  const current = await f.settings.load();
  const legacy = await (await f.request(PROJECTS_PATH)).json();
  expect(legacy.settings.projects[0]).not.toHaveProperty("autonomy");
  expect(legacy).not.toHaveProperty("autonomyDefaults");
  expect(legacy.revision).toBe(projectsRevision(current.projects));
  const snapshot = await f.client.projects();
  expect(snapshot.autonomyDefaults).toEqual(current.autonomy);
  expect(snapshot.settings.projects[0]!.autonomy).toEqual({
    fleet: { closure: "owner", machineSetup: "owner" },
  });
  const updated = await f.client.updateProjectSettings({
    projectId: "garden",
    expectedRevision: snapshot.revision,
    changes: { autonomy: { fleet: { closure: null } } },
  });
  expect(updated.settings.projects[0]!.autonomy).toEqual({ fleet: { machineSetup: "owner" } });
  expect(updated.autonomyDefaults).toEqual(current.autonomy);
  const legacyMutation = await (
    await f.request(PROJECT_UPDATE_SETTINGS_PATH, {
      projectId: "garden",
      expectedRevision: updated.revision,
      changes: { name: "Garden renamed" },
    })
  ).json();
  expect(legacyMutation.settings.projects[0]).not.toHaveProperty("autonomy");
  expect(legacyMutation).not.toHaveProperty("autonomyDefaults");
  expect(legacyMutation.revision).toBe(projectsRevision((await f.settings.load()).projects));
});

it("derives policy from the real local source cwd, verifies aliases and current linked target independently, and refuses unknown or mismatched contexts", async () => {
  const f = await fixture();
  const alias = join(f.root, "alias");
  await symlink(f.cwd, alias);
  const context = FleetSettingsContextSchema.parse(
    await f.client.fleetSettingsContext({ workingDirectory: alias, machine: "pc-work", projectId: "garden" }),
  );
  expect(context).toEqual({
    schemaVersion: 1,
    effective: { closure: "owner", machineSetup: "owner" },
    projectId: "garden",
    machine: { id: "pc", linked: true },
  });
  expect(
    (await f.client.fleetSettingsContext({ workingDirectory: f.other, machine: "local" })).effective,
  ).toEqual({ closure: "lead", machineSetup: "lead" });
  f.disconnect();
  expect(
    (await f.client.fleetSettingsContext({ workingDirectory: f.cwd, machine: "pc" })).machine.linked,
  ).toBe(false);
  for (const input of [
    { workingDirectory: join(f.root, "missing"), machine: "local" },
    { workingDirectory: f.cwd, machine: "unknown" },
    { workingDirectory: f.cwd, machine: "local", projectId: "other" },
  ])
    await expect(f.client.fleetSettingsContext(input)).rejects.toThrow("409");
  await f.settings.update((current) => ({
    ...current,
    projects: ProjectsSettingsSchema.parse({
      projects: [
        ...current.projects.projects,
        {
          id: "nested",
          name: "Nested",
          workspaces: [{ id: "same", machineId: "local", platform: "posix", path: f.cwd }],
        },
      ],
    }),
  }));
  await expect(f.client.fleetSettingsContext({ workingDirectory: f.cwd, machine: "local" })).rejects.toThrow(
    "409",
  );
});

it("uses real Git registration for sibling worktree policy and denies unregistered folders in the approved namespace", async () => {
  const f = await fixture();
  await exec("git", ["init", f.cwd]);
  await exec("git", [
    "-C",
    f.cwd,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  const root = join(f.root, "worktrees");
  await mkdir(root);
  const worktree = join(root, "active");
  await exec("git", ["-C", f.cwd, "worktree", "add", worktree, "-b", "fixture-worker"]);
  const input = {
    projectId: "garden",
    machineId: "local",
    platform: "posix" as const,
    path: root,
    repoPath: f.cwd,
  };
  const observed = await observeLocalProjectWorktreeRoot(input);
  expect(observed).toBeDefined();
  await f.settings.update((current) => ({
    ...current,
    projects: addProjectWorktreeRoot(
      current.projects,
      { ...input, expectedRevision: projectsRevision(current.projects) },
      observed!,
    ),
  }));
  expect(
    (await f.client.fleetSettingsContext({ workingDirectory: worktree, machine: "local" })).projectId,
  ).toBe("garden");
  const fake = join(root, "unregistered");
  await mkdir(fake);
  await expect(f.client.fleetSettingsContext({ workingDirectory: fake, machine: "local" })).rejects.toThrow(
    "409",
  );
});

it("requires explicit approval under owner machineSetup and a linked target for automatic lead preparation", async () => {
  const f = await fixture();
  const path = "/v1/runtime-connections/pc-work/prepare";
  expect((await f.request(path, { workingDirectory: f.cwd })).status).toBe(403);
  expect(f.prepared).toEqual([]);
  expect(
    (
      await f.request(path, {
        workingDirectory: f.cwd,
        projectId: "garden",
        ownerApproved: true,
        codexSourceSetup: "/owner/setup.py",
      })
    ).status,
  ).toBe(200);
  expect(f.prepared).toEqual([{ id: "pc-work", options: { codexSourceSetup: "/owner/setup.py" } }]);
  expect((await f.request(path, { workingDirectory: f.other })).status).toBe(200);
  f.disconnect();
  expect((await f.request(path, { workingDirectory: f.other })).status).toBe(403);
  expect(
    (
      await f.request(path, {
        workingDirectory: f.cwd,
        ownerApproved: true,
        codexSourceSetup: "relative/script",
      })
    ).status,
  ).toBe(400);
  expect(
    (await f.request(path, { workingDirectory: f.cwd, ownerApproved: true, projectId: "wrong" })).status,
  ).toBe(409);
  f.revoke();
  expect((await f.request(path, { workingDirectory: f.cwd, ownerApproved: true })).status).toBe(401);
  expect(f.prepared).toHaveLength(2);
});
