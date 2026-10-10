import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { ClankieApiClient } from "../../../packages/api-client/src/index.ts";
import {
  ProjectsSettingsSchema,
  ProjectsSnapshotSchema,
  FleetSettingsSnapshotSchema,
  FleetSettingsContextSchema,
  FleetAutonomySchema,
  PROJECTS_PATH,
  PROJECT_UPDATE_SETTINGS_PATH,
  FLEET_HIRE_DEFAULTS_PATH,
  FleetHireDefaultsSnapshotSchema,
  OPERATOR_PERSONA_PATH,
  PersonaAttentionSnapshotSchema,
  WORKER_ACCOUNT_HOLDS_PATH,
  WorkerAccountHoldsSchema,
} from "@clankie/protocol";
import {
  SettingsStore,
  projectsRevision,
  observeLocalProjectWorktreeRoot,
  addProjectWorktreeRoot,
} from "@clankie/settings";
import { createClankieApp } from "../src/app.ts";
import { createStubCaptain, type CaptainPort } from "../src/captain/port.ts";
import { projectStatuses } from "../src/captain/auto-projects.ts";
import { ExecutionConnections } from "../src/herdr-session.ts";

const exec = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});
async function fixture(captain: Partial<CaptainPort> = {}) {
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
  const preparedTargets: Array<{ id: string; session: string; ssh: { host: string; shell: string } }> = [];
  const refreshed: string[] = [];
  let refreshCalls = 0;
  const refreshHooks: { beforeRemote?: (() => Promise<void>) | undefined } = {};
  const authHooks: { beforeReturn?: (() => Promise<void>) | undefined } = {};
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
    captain: createStubCaptain(captain),
    settings,
    runtimes,
    herdrBinding: () => binding,
    authenticateOperator: async (request) => {
      if (request.headers.get("authorization") !== "Bearer owner" || !authorized || ++authCalls >= revokeAt)
        return undefined;
      await authHooks.beforeReturn?.();
      return { operatorId: "owner" };
    },
    prepareFleet: async (id, options, target) => {
      prepared.push({ id, options });
      preparedTargets.push(target);
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
    preparedTargets,
    authHooks,
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
  expect(original.workingPreferences).toBe(true);
  expect(original.fleet).toEqual({ ...before.fleet, ...FleetAutonomySchema.parse({}) });
  const updated = FleetSettingsSnapshotSchema.parse(
    await f.client.updateFleetSettings({
      schemaVersion: 1,
      expectedRevision: original.revision,
      changes: { size: "small", models: "efficient", closure: "owner", machineSetup: "owner" },
    }),
  );
  expect(updated.fleet).toEqual({
    ...before.fleet,
    size: "small",
    models: "efficient",
    ...FleetAutonomySchema.parse({}),
    closure: "owner",
    machineSetup: "owner",
  });
  const saved = await new SettingsStore(f.settings.path).load();
  expect(saved.autonomy.fleet).toEqual({
    ...FleetAutonomySchema.parse({}),
    closure: "owner",
    machineSetup: "owner",
  });
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

it("roundtrips working preferences, resolves each project override and restores inheritance through the owner API", async () => {
  const f = await fixture();
  const before = await f.settings.load();
  const initial = await f.client.fleetSettings();
  const rule =
    "Release without asking when the last v* tag is more than one week old and main has user-visible changes worth shipping.";
  const global = {
    commit: "owner" as const,
    push: "owner" as const,
    release: { mode: "time_rule" as const, rule },
    verification: "review_and_seal" as const,
    reportingStyle: "One short paragraph with evidence.",
  };
  const updated = await f.client.updateFleetSettings({
    schemaVersion: 1,
    expectedRevision: initial.revision,
    changes: global,
  });
  expect(updated.fleet).toEqual({ ...before.fleet, ...before.autonomy.fleet, ...global });
  const projects = await f.client.projects();
  const overrides = {
    commit: "lead" as const,
    release: { mode: "owner" as const },
    reportingStyle: "Short and plain.",
  };
  const project = await f.client.updateProjectSettings({
    projectId: "garden",
    expectedRevision: projects.revision,
    changes: { autonomy: { fleet: overrides } },
  });
  expect(project.settings.projects[0]!.autonomy!.fleet).toEqual({
    closure: "owner",
    machineSetup: "owner",
    ...overrides,
  });
  const resolved = await f.client.fleetSettingsContext({ workingDirectory: f.cwd, machine: "local" });
  expect(resolved.workingPreferences).toBe(true);
  expect(resolved.effective).toEqual({
    ...before.autonomy.fleet,
    ...global,
    closure: "owner",
    machineSetup: "owner",
    ...overrides,
  });
  const inherited = await f.client.updateProjectSettings({
    projectId: "garden",
    expectedRevision: project.revision,
    changes: { autonomy: { fleet: { commit: null, release: null } } },
  });
  expect(inherited.settings.projects[0]!.autonomy!.fleet).toEqual({
    closure: "owner",
    machineSetup: "owner",
    reportingStyle: "Short and plain.",
  });
  expect(
    (await f.client.fleetSettingsContext({ workingDirectory: f.cwd, machine: "local" })).effective,
  ).toEqual({
    ...before.autonomy.fleet,
    ...global,
    closure: "owner",
    machineSetup: "owner",
    reportingStyle: "Short and plain.",
  });
  const reset = await f.client.updateFleetSettings({
    schemaVersion: 1,
    expectedRevision: updated.revision,
    changes: { commit: null, push: null, release: null, verification: null, reportingStyle: null },
  });
  expect(reset.fleet).toEqual(initial.fleet);
  const persisted = await new SettingsStore(f.settings.path).load();
  expect(persisted.autonomy.fleet).toEqual(before.autonomy.fleet);
  expect(persisted.projects.projects[0]!.workspaces).toEqual(before.projects.projects[0]!.workspaces);
  expect(persisted.machines).toEqual(before.machines);
  expect(persisted.fleet).toEqual(before.fleet);
});

it("rejects malformed release modes, rules and reporting styles without changing owner settings", async () => {
  const f = await fixture();
  const initial = await f.client.fleetSettings();
  const before = await f.settings.load();
  for (const changes of [
    { release: { mode: "time_rule" } },
    { release: { mode: "time_rule", rule: " " } },
    { release: { mode: "owner", rule: "hidden stale rule" } },
    { reportingStyle: " " },
    { verification: "skip_checks" },
  ]) {
    expect(
      (
        await f.request("/v1/operator/fleet-settings", {
          schemaVersion: 1,
          expectedRevision: initial.revision,
          changes,
        })
      ).status,
    ).toBe(400);
  }
  expect(await f.settings.load()).toEqual(before);
  const reportingStyle = "界".repeat(2000);
  const release = { mode: "time_rule" as const, rule: "界".repeat(2000) };
  const multilingual = await f.client.updateFleetSettings({
    schemaVersion: 1,
    expectedRevision: initial.revision,
    changes: { release, reportingStyle },
  });
  expect(multilingual.fleet.release).toEqual(release);
  expect(multilingual.fleet.reportingStyle).toBe(reportingStyle);
});

it("gates explicit linked refresh with canonical current source policy, per-target links and live operator authority", async () => {
  const f = await fixture();
  const path = "/v1/harness-refresh";
  expect(
    (await f.app.app.request(path, { method: "POST", headers: { authorization: "Bearer owner" } })).status,
  ).toBe(400);
  expect((await f.request(path, { workingDirectory: f.cwd })).status).toBe(403);
  expect(f.refreshCalls()).toBe(0);
  const approved = await f.request(path, {
    workingDirectory: f.cwd,
    projectId: "garden",
    ownerApproved: true,
  });
  expect(approved.status).toBe(200);
  expect((await approved.json()).ownerApproval).toBe("claimed");
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
  const automatic = await f.request(path, { workingDirectory: f.cwd });
  expect(automatic.status).toBe(200);
  expect((await automatic.json()).ownerApproval).toBe("not_claimed");
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
  expect(legacy).not.toHaveProperty("workingPreferences");
  expect(legacy.revision).toBe(projectsRevision(current.projects));
  const snapshot = await f.client.projects();
  expect(snapshot.workingPreferences).toBe(true);
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
  expect(context).toMatchObject({
    schemaVersion: 1,
    effective: { closure: "owner", machineSetup: "owner" },
    projectId: "garden",
    machine: { id: "pc", linked: true },
  });
  expect(context.machine.targetRevision).toMatch(/^[a-f0-9]{64}$/u);
  expect(
    (await f.client.fleetSettingsContext({ workingDirectory: f.cwd, machine: "pc-work" })).machine
      .targetRevision,
  ).toBe(context.machine.targetRevision);
  expect(
    (await f.client.fleetSettingsContext({ workingDirectory: f.other, machine: "local" })).effective,
  ).toEqual(FleetAutonomySchema.parse({}));
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

it("records caller approval claims and requires consent for owner policy or newly supplied source scripts", async () => {
  const f = await fixture();
  const path = "/v1/runtime-connections/pc-work/prepare";
  expect((await f.request(path, { workingDirectory: f.cwd })).status).toBe(403);
  expect(f.prepared).toEqual([]);
  const approved = await f.request(path, {
    workingDirectory: f.cwd,
    projectId: "garden",
    ownerApproved: true,
    codexSourceSetup: "/owner/setup.py",
  });
  expect(approved.status).toBe(200);
  expect(await approved.json()).toEqual({ ok: true, prepared: { machine: "pc" }, ownerApproval: "claimed" });
  expect(f.prepared).toEqual([{ id: "pc-work", options: { codexSourceSetup: "/owner/setup.py" } }]);
  expect(f.preparedTargets).toEqual([
    { id: "pc-work", session: "work", ssh: { host: "fixture.invalid", shell: "posix" } },
  ]);
  const freshSource = await f.request(path, { workingDirectory: f.other, codexSourceSetup: "/new/setup.py" });
  expect(freshSource.status).toBe(403);
  expect(await freshSource.json()).toEqual({ error: "machine_setup_owner_approval_required" });
  expect(f.prepared).toHaveLength(1);
  const automatic = await f.request(path, { workingDirectory: f.other });
  expect(automatic.status).toBe(200);
  expect(await automatic.json()).toEqual({
    ok: true,
    prepared: { machine: "pc" },
    ownerApproval: "not_claimed",
  });
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

it("refuses fleet retargeting during final owner authentication before preparing the captured target", async () => {
  const f = await fixture();
  let calls = 0;
  f.authHooks.beforeReturn = async () => {
    if (++calls !== 2) return;
    await f.settings.update((current) => ({
      ...current,
      machines: current.machines.map((machine) => ({ ...machine, ssh: "retargeted-fixture.invalid" })),
      agentHosts: {
        connections: current.agentHosts.connections.map((host) => ({
          ...host,
          ssh: "retargeted-fixture.invalid",
        })),
      },
      execution: {
        connections: current.execution.connections.map((connection) => ({
          ...connection,
          session: "retargeted",
          ssh: { ...connection.ssh!, host: "retargeted-fixture.invalid" },
        })),
      },
    }));
  };
  const response = await f.request("/v1/runtime-connections/pc-work/prepare", {
    workingDirectory: f.cwd,
    ownerApproved: true,
    codexSourceSetup: "/owner/setup.py",
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: "fleet_prepare_failed",
    detail: "Machine setup settings changed",
  });
  expect(f.prepared).toEqual([]);
  expect(f.preparedTargets).toEqual([]);
});

it("pins preparation claims to the registered target shown during consent while legacy claims use the current alias", async () => {
  const f = await fixture();
  const path = "/v1/runtime-connections/pc-work/prepare";
  const input = { workingDirectory: f.cwd, machine: "pc-work" };
  const prompted = await f.client.fleetSettingsContext(input);
  const claimed = await f.request(path, {
    workingDirectory: f.cwd,
    ownerApproved: true,
    expectedMachineRevision: prompted.machine.targetRevision,
  });
  expect(claimed.status).toBe(200);
  expect((await claimed.json()).ownerApproval).toBe("claimed");
  await f.settings.update((current) => ({
    ...current,
    machines: current.machines.map((machine) => ({ ...machine, ssh: "new-fixture.invalid" })),
    agentHosts: {
      connections: current.agentHosts.connections.map((host) => ({ ...host, ssh: "new-fixture.invalid" })),
    },
    execution: {
      connections: current.execution.connections.map((connection) => ({
        ...connection,
        session: "new-session",
        ssh: { ...connection.ssh!, host: "new-fixture.invalid" },
      })),
    },
  }));
  const rebound = await f.client.fleetSettingsContext(input);
  expect(rebound.machine.id).toBe(prompted.machine.id);
  expect(rebound.machine.targetRevision).not.toBe(prompted.machine.targetRevision);
  const stale = await f.request(path, {
    workingDirectory: f.cwd,
    ownerApproved: true,
    expectedMachineRevision: prompted.machine.targetRevision,
  });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({ error: "machine_setup_target_changed" });
  expect(f.prepared).toHaveLength(1);
  expect(
    (
      await f.request(path, {
        workingDirectory: f.cwd,
        ownerApproved: true,
        expectedMachineRevision: rebound.machine.targetRevision,
      })
    ).status,
  ).toBe(200);
  expect(f.preparedTargets.at(-1)).toEqual({
    id: "pc-work",
    session: "new-session",
    ssh: { host: "new-fixture.invalid", shell: "posix" },
  });
  const currentAlias = await f.request(path, { workingDirectory: f.cwd, ownerApproved: true });
  expect(currentAlias.status).toBe(200);
  expect((await currentAlias.json()).ownerApproval).toBe("claimed");
  const malformed = await f.request(path, {
    workingDirectory: f.cwd,
    ownerApproved: true,
    expectedMachineRevision: "not-a-revision",
  });
  expect(malformed.status).toBe(400);
  expect(f.prepared).toHaveLength(3);
  expect(
    (
      await f.request("/v1/harness-refresh", {
        workingDirectory: f.cwd,
        ownerApproved: true,
        expectedMachineRevision: rebound.machine.targetRevision,
      })
    ).status,
  ).toBe(400);
  expect(f.refreshCalls()).toBe(0);
});

it("round-trips fleet gates across owner API, disk, project inheritance and the shared client schema", async () => {
  const f = await fixture();
  const initial = await f.client.fleetSettings();
  expect(initial.fleetGates).toBe(true);
  const updated = await f.client.updateFleetSettings({
    schemaVersion: 1,
    expectedRevision: initial.revision,
    changes: { everydayWork: "lead", leavesMac: "owner", hardToUndo: "owner" },
  });
  expect(updated.fleet.everydayWork).toBe("lead");
  expect((await new SettingsStore(f.settings.path).load()).autonomy.fleet.leavesMac).toBe("owner");
  const projects = await f.client.projects();
  const overridden = await f.client.updateProjectSettings({
    projectId: "garden",
    expectedRevision: projects.revision,
    changes: { autonomy: { fleet: { leavesMac: "lead" } } },
  });
  const context = await f.client.fleetSettingsContext({ workingDirectory: f.cwd, machine: "local" });
  expect(context.fleetGates).toBe(true);
  expect(context.effective).toMatchObject({
    everydayWork: "lead",
    leavesMac: "lead",
    moneyAndAccounts: "owner",
  });
  await f.client.updateProjectSettings({
    projectId: "garden",
    expectedRevision: overridden.revision,
    changes: { autonomy: { fleet: { leavesMac: null } } },
  });
  expect(
    (await f.client.fleetSettingsContext({ workingDirectory: f.cwd, machine: "local" })).effective.leavesMac,
  ).toBe("owner");
  const refused = await f.request("/v1/operator/fleet-settings", {
    schemaVersion: 1,
    expectedRevision: updated.revision,
    changes: { moneyAndAccounts: "allow" },
  });
  expect(refused.status).toBe(400);
  expect((await f.settings.load()).autonomy.fleet.moneyAndAccounts).toBe("owner");
  expect((await f.settings.load()).autonomy.fleet.push).toBe(initial.fleet.push);
  expect((await f.settings.load()).autonomy.fleet.release).toEqual(initial.fleet.release);
});

it("sets the autonomy dial's leaves in one owner write and reads hand-set leaves as custom", async () => {
  const f = await fixture();
  const initial = await f.client.fleetSettings();
  expect(initial.autonomyLevel).toBe("high");
  expect(initial.fleet.hardToUndo).toBe("lead");

  const off = await f.client.updateFleetSettings({
    schemaVersion: 1,
    expectedRevision: initial.revision,
    changes: { autonomyLevel: "off" },
  });
  expect(off.autonomyLevel).toBe("off");
  const stored = (await new SettingsStore(f.settings.path).load()).autonomy.fleet;
  expect(stored).toMatchObject({
    everydayWork: "owner",
    leavesMac: "owner",
    hardToUndo: "owner",
    closure: "owner",
    commit: "owner",
    push: "owner",
    release: { mode: "owner" },
  });
  expect(stored.verification).toBe(initial.fleet.verification);

  const full = await f.client.updateFleetSettings({
    schemaVersion: 1,
    expectedRevision: off.revision,
    changes: { autonomyLevel: "full", release: { mode: "time_rule", rule: "weekly" } },
  });
  expect(full.autonomyLevel).toBe("custom");
  expect(full.fleet).toMatchObject({ leavesMac: "allow", release: { mode: "time_rule", rule: "weekly" } });

  const low = await f.client.updateFleetSettings({
    schemaVersion: 1,
    expectedRevision: full.revision,
    changes: { autonomyLevel: "low" },
  });
  expect(low.autonomyLevel).toBe("low");
  expect(low.fleet).toMatchObject({ everydayWork: "lead", commit: "lead", push: "owner" });

  const custom = await f.request("/v1/operator/fleet-settings", {
    schemaVersion: 1,
    expectedRevision: low.revision,
    changes: { autonomyLevel: "custom" },
  });
  expect(custom.status).toBe(400);
});

it("puts a project on Auto with a focus through the owner project API, hidden from the plain view", async () => {
  const f = await fixture();
  const initial = await f.client.projects();
  expect(initial.projectsAuto).toBe(true);
  const auto = await f.client.updateProjectSettings({
    projectId: "garden",
    expectedRevision: initial.revision,
    changes: { auto: true, focus: "Ship offline mode" },
  });
  expect(auto.settings.projects.find((project) => project.id === "garden")).toMatchObject({
    auto: true,
    focus: "Ship offline mode",
  });
  expect((await new SettingsStore(f.settings.path).load()).projects.projects[0]).toMatchObject({
    auto: true,
    focus: "Ship offline mode",
  });
  const plain = ProjectsSnapshotSchema.parse(await (await f.request(PROJECTS_PATH)).json());
  expect(plain.projectsAuto).toBeUndefined();
  expect(plain.settings.projects[0]).not.toHaveProperty("auto");
  expect(plain.settings.projects[0]).not.toHaveProperty("focus");

  const tooLong = await f.request(`${PROJECT_UPDATE_SETTINGS_PATH}?includeAutonomy=true`, {
    projectId: "garden",
    expectedRevision: auto.revision,
    changes: { focus: "x".repeat(281) },
  });
  expect(tooLong.status).toBe(400);
  const off = await f.client.updateProjectSettings({
    projectId: "garden",
    expectedRevision: auto.revision,
    changes: { auto: false, focus: null },
  });
  const garden = off.settings.projects.find((project) => project.id === "garden");
  expect(garden).not.toHaveProperty("auto");
  expect(garden).not.toHaveProperty("focus");
});

it("reads each project's status line from live seats, landed commits and pending owner questions", async () => {
  let workspace = "";
  const f = await fixture({
    projectStatus: async (projects) => ({
      // Live seats and pending questions as the service reads them; one of each sits outside the project.
      projects: await projectStatuses(
        projects,
        [join(workspace, "apps"), "/elsewhere"],
        [workspace, undefined, "/elsewhere"],
      ),
      needsYou: 3,
    }),
  });
  workspace = (await f.client.projects()).settings.projects[0]!.workspaces[0]!.path;
  const git = (...args: string[]) =>
    exec("git", [
      "-C",
      workspace,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      ...args,
    ]);
  const origin = join(workspace, "..", "origin.git");
  await exec("git", ["init", "-q", "--bare", "-b", "main", origin]);
  await git("init", "-q", "-b", "main");
  await git("remote", "add", "origin", origin);
  // Landed two days ago: not today.
  await exec(
    "git",
    [
      "-C",
      workspace,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "old",
    ],
    {
      env: { ...process.env, GIT_COMMITTER_DATE: new Date(Date.now() - 2 * 86_400_000).toISOString() },
    },
  );
  await git("commit", "-q", "--allow-empty", "-m", "landed today");
  await git("push", "-q", "origin", "main");
  await git("commit", "-q", "--allow-empty", "-m", "local only");

  const view = await f.client.projects();
  expect(view.projectStatus?.garden).toEqual({ agentsWorking: 1, landedToday: 1, needsYou: 1 });
  expect(view.needsYou).toBe(3);
  const plain = ProjectsSnapshotSchema.parse(await (await f.request(PROJECTS_PATH)).json());
  expect(plain.projectStatus).toBeUndefined();
  expect(plain.needsYou).toBeUndefined();
});

it("sets hire defaults, talkativeness and worker-account holds through the owner API the app and TUI share", async () => {
  const f = await fixture();
  await f.settings.update((current) => ({
    ...current,
    fleet: { ...current.fleet, hire: { harness: "codex", account: "work", placement: "split" } },
  }));
  const hire = FleetHireDefaultsSnapshotSchema.parse(
    await (await f.request(FLEET_HIRE_DEFAULTS_PATH)).json(),
  );
  expect(hire.hire).toEqual({ harness: "codex" });
  const set = await f.request(FLEET_HIRE_DEFAULTS_PATH, {
    schemaVersion: 1,
    expectedRevision: hire.revision,
    changes: { harness: "auto", model: "gpt-6", effort: "high" },
  });
  expect(set.status).toBe(200);
  const updated = FleetHireDefaultsSnapshotSchema.parse(await set.json());
  expect(updated.hire).toEqual({ model: "gpt-6", effort: "high" });
  // No preference is never stored, and fields this route does not show are kept.
  expect((await new SettingsStore(f.settings.path).load()).fleet.hire).toEqual({
    account: "work",
    placement: "split",
    model: "gpt-6",
    effort: "high",
  });
  const stale = await f.request(FLEET_HIRE_DEFAULTS_PATH, {
    schemaVersion: 1,
    expectedRevision: hire.revision,
    changes: { effort: "low" },
  });
  expect(stale.status).toBe(409);
  expect(
    (
      await f.request(FLEET_HIRE_DEFAULTS_PATH, {
        schemaVersion: 1,
        expectedRevision: updated.revision,
        changes: { harness: "not-a-harness" },
      })
    ).status,
  ).toBe(400);

  const attention = PersonaAttentionSnapshotSchema.parse(
    await (await f.request(OPERATOR_PERSONA_PATH)).json(),
  );
  const persona = await f.request(OPERATOR_PERSONA_PATH, {
    expectedRevision: attention.revision,
    persona: { chattiness: "quiet", replyPolicy: "addressed" },
  });
  expect(PersonaAttentionSnapshotSchema.parse(await persona.json()).persona).toEqual({
    chattiness: "quiet",
    replyPolicy: "addressed",
  });

  const holds = WorkerAccountHoldsSchema.parse(await (await f.request(WORKER_ACCOUNT_HOLDS_PATH)).json());
  const held = await f.request(WORKER_ACCOUNT_HOLDS_PATH, {
    expectedRevision: holds.revision,
    harness: "codex",
    label: "work",
    held: true,
    reason: "plan lapses Friday",
  });
  const heldSnapshot = WorkerAccountHoldsSchema.parse(await held.json());
  expect(heldSnapshot.holds).toEqual([
    { machine: "local", harness: "codex", label: "work", reason: "plan lapses Friday" },
  ]);
  const released = await f.request(WORKER_ACCOUNT_HOLDS_PATH, {
    expectedRevision: heldSnapshot.revision,
    machine: "local",
    harness: "codex",
    label: "work",
    held: false,
  });
  expect(WorkerAccountHoldsSchema.parse(await released.json()).holds).toEqual([]);
  expect(
    (
      await f.request(WORKER_ACCOUNT_HOLDS_PATH, {
        harness: "codex",
        label: "work",
        held: false,
        reason: "x",
      })
    ).status,
  ).toBe(400);

  f.revoke();
  expect((await f.request(FLEET_HIRE_DEFAULTS_PATH)).status).toBe(401);
  expect(
    (await f.request(WORKER_ACCOUNT_HOLDS_PATH, { harness: "codex", label: "work", held: true })).status,
  ).toBe(401);
  expect((await f.request(OPERATOR_PERSONA_PATH, { chattiness: "chatty" })).status).toBe(401);
});
