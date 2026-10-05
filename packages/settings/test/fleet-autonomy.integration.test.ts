import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  AutonomySettingsSchema,
  FLEET_AUTONOMY_DEFAULTS,
  FLEET_AUTONOMY_FIELDS,
  FLEET_WORKING_PREFERENCE_FIELDS,
  FleetSettingsSnapshotSchema,
  FleetSettingsContextSchema,
  UpdateFleetSettingsSchema,
  effectiveFleetAutonomy,
  ProjectAutonomySchema,
  ProjectsSnapshotSchema,
  UpdateProjectSettingsSchema,
  type UpdateProjectSettings,
} from "@clankie/protocol";
import {
  SettingsStore,
  LinearWakeSettingsSchema,
  LEGACY_CLANKIE_RELEASE_RULE,
  projectsRevision,
  updateProjectSettings,
} from "../src/index.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(options: { projectId?: string; autonomy?: unknown; projectAutonomy?: unknown } = {}) {
  const projectId = options.projectId ?? "garden";
  const root = await mkdtemp(join(tmpdir(), "fleet-autonomy-settings-"));
  roots.push(root);
  const store = new SettingsStore(join(root, "settings.json"));
  await writeFile(
    store.path,
    JSON.stringify({
      schemaVersion: 1,
      ...(options.autonomy === undefined ? {} : { autonomy: options.autonomy }),
      fleet: { size: "small", models: "efficient", tools: "off" },
      projects: {
        projects: [
          {
            id: projectId,
            name: "Garden",
            roles: [{ role: "builder", concurrencyCap: 2 }],
            workerCap: 4,
            fleet: { size: "solo" },
            labelRoleMap: [{ label: "implementation", role: "builder" }],
            grants: [{ id: "read", server: "repo", accountId: "personal", tools: [{ name: "read" }] }],
            ...(options.projectAutonomy === undefined ? {} : { autonomy: options.projectAutonomy }),
          },
          { id: "other", name: "Other" },
        ],
        assignments: [{ projectId, personaId: "rook", role: "builder" }],
      },
    }),
  );
  const patch = async (changes: UpdateProjectSettings["changes"], expectedRevision?: string) => {
    const command = UpdateProjectSettingsSchema.parse({
      projectId,
      changes,
      expectedRevision: expectedRevision ?? projectsRevision((await store.load()).projects),
    });
    return store.update((current) => ({
      ...current,
      projects: updateProjectSettings(current.projects, command),
    }));
  };
  return { store, patch };
}

it("loads old settings with lead defaults, persists owner policy and independently resolves project overrides after restart", async () => {
  const f = await fixture();
  const legacy = await f.store.load();
  expect(legacy.autonomy).toEqual({ fleet: FLEET_AUTONOMY_DEFAULTS });
  expect(legacy.projects.projects[0]!.autonomy).toBeUndefined();
  expect(legacy.fleet).toMatchObject({ size: "small", models: "efficient", tools: "off" });
  await f.store.update((current) => ({
    ...current,
    autonomy: { fleet: { ...current.autonomy.fleet, closure: "owner", machineSetup: "lead" } },
  }));
  await f.patch({ autonomy: { fleet: { machineSetup: "owner" } } });
  const restarted = new SettingsStore(f.store.path);
  const saved = await restarted.load();
  expect(saved.projects.projects[0]!.autonomy).toEqual({ fleet: { machineSetup: "owner" } });
  expect(effectiveFleetAutonomy(saved.autonomy, saved.projects.projects[0]!.autonomy)).toEqual({
    ...FLEET_AUTONOMY_DEFAULTS,
    closure: "owner",
    machineSetup: "owner",
  });
  await restarted.update((current) => ({
    ...current,
    autonomy: { fleet: { ...current.autonomy.fleet, closure: "lead" } },
  }));
  const changed = await f.store.load();
  expect(effectiveFleetAutonomy(changed.autonomy, changed.projects.projects[0]!.autonomy)).toEqual({
    ...FLEET_AUTONOMY_DEFAULTS,
    closure: "lead",
    machineSetup: "owner",
  });
  expect(JSON.parse(await readFile(f.store.path, "utf8")).autonomy).toEqual({
    fleet: FLEET_AUTONOMY_DEFAULTS,
  });
});

it("clears only the patched project leaf, preserves unrelated policy and stale-write fencing, and removes empty overrides", async () => {
  const f = await fixture();
  await f.patch({ autonomy: { fleet: { closure: "owner", machineSetup: "owner" } } });
  const before = await f.store.load();
  const stale = projectsRevision(before.projects);
  await f.patch({ autonomy: { fleet: { closure: null } } });
  const after = await f.store.load();
  const project = after.projects.projects[0]!;
  expect(project.autonomy).toEqual({ fleet: { machineSetup: "owner" } });
  expect({ ...project, autonomy: before.projects.projects[0]!.autonomy }).toEqual(
    before.projects.projects[0],
  );
  expect(after.projects.projects[1]).toEqual(before.projects.projects[1]);
  expect(after.projects.assignments).toEqual(before.projects.assignments);
  expect(effectiveFleetAutonomy(after.autonomy, project.autonomy)).toEqual({
    ...FLEET_AUTONOMY_DEFAULTS,
    closure: "lead",
    machineSetup: "owner",
  });
  await expect(f.patch({ autonomy: { fleet: { closure: "owner" } } }, stale)).rejects.toThrow(
    "Project settings changed",
  );
  expect(await f.store.load()).toEqual(after);
  await f.patch({ autonomy: { fleet: { machineSetup: null } } });
  const cleared = await new SettingsStore(f.store.path).load();
  expect(cleared.projects.projects[0]!.autonomy).toBeUndefined();
  const disk = JSON.parse(await readFile(f.store.path, "utf8"));
  expect(disk.projects.projects[0]).not.toHaveProperty("autonomy");
  expect(effectiveFleetAutonomy(cleared.autonomy, cleared.projects.projects[0]!.autonomy)).toEqual({
    ...FLEET_AUTONOMY_DEFAULTS,
    closure: "lead",
    machineSetup: "lead",
  });
});

it("keeps persisted policy strict, treats null as patch-only, and leaves legacy snapshot capability absent", async () => {
  const f = await fixture();
  const before = await f.store.load();
  for (const autonomy of [
    { fleet: { closure: "always" } },
    { fleet: { machineSetup: null } },
    { fleet: { machineSetup: "lead", credentials: "lead" } },
    { schedule: "lead" },
  ]) {
    expect(AutonomySettingsSchema.safeParse(autonomy).success).toBe(false);
    expect(ProjectAutonomySchema.safeParse(autonomy).success).toBe(false);
  }
  for (const autonomy of [{}, { fleet: {} }, { fleet: { closure: "lead", accounts: "lead" } }]) {
    expect(
      UpdateProjectSettingsSchema.safeParse({
        projectId: "garden",
        expectedRevision: projectsRevision(before.projects),
        changes: { autonomy },
      }).success,
    ).toBe(false);
  }
  const snapshot = { settings: before.projects, revision: projectsRevision(before.projects) };
  expect(ProjectsSnapshotSchema.parse(snapshot)).not.toHaveProperty("autonomyDefaults");
  const current = ProjectsSnapshotSchema.parse({ ...snapshot, autonomyDefaults: before.autonomy });
  expect(current.autonomyDefaults).toEqual(before.autonomy);
  expect(effectiveFleetAutonomy(undefined)).toEqual(FLEET_AUTONOMY_DEFAULTS);
  expect(await f.store.load()).toEqual(before);
});

it("round-trips every working preference, replaces release atomically, and clears every project leaf back to inheritance", async () => {
  const f = await fixture();
  await f.store.update((current) => ({
    ...current,
    autonomy: AutonomySettingsSchema.parse({
      fleet: {
        ...current.autonomy.fleet,
        commit: "owner",
        push: "owner",
        release: { mode: "time_rule", rule: "  Release after the monthly review.  " },
        verification: "review_and_seal",
        reportingStyle: "  State the result, evidence, and remaining decisions.  ",
      },
    }),
  }));
  const global = (await f.store.load()).autonomy;
  expect(global.fleet).toMatchObject({
    release: { mode: "time_rule", rule: "Release after the monthly review." },
    reportingStyle: "State the result, evidence, and remaining decisions.",
  });
  await f.patch({
    autonomy: {
      fleet: {
        closure: "owner",
        machineSetup: "owner",
        commit: "lead",
        push: "lead",
        release: { mode: "time_rule", rule: "Release after the project review." },
        verification: "change_run_read",
        reportingStyle: "Keep project reports brief.",
      },
    },
  });
  const overridden = await new SettingsStore(f.store.path).load();
  expect(effectiveFleetAutonomy(overridden.autonomy, overridden.projects.projects[0]!.autonomy)).toEqual({
    closure: "owner",
    machineSetup: "owner",
    commit: "lead",
    push: "lead",
    release: { mode: "time_rule", rule: "Release after the project review." },
    verification: "change_run_read",
    reportingStyle: "Keep project reports brief.",
  });
  await f.patch({ autonomy: { fleet: { release: { mode: "lead" } } } });
  const replaced = await f.store.load();
  expect(replaced.projects.projects[0]!.autonomy!.fleet!.release).toEqual({ mode: "lead" });
  const bytes = await readFile(f.store.path, "utf8");
  for (const invalid of [
    { release: { mode: "time_rule" } },
    { release: { rule: "A partial rule cannot replace a release policy." } },
    { release: { mode: "lead", rule: "A stale rule cannot survive this mode." } },
    { release: { mode: "time_rule", rule: "   " } },
    { reportingStyle: "   " },
    { reportingStyle: "a".repeat(2001) },
  ]) {
    expect(
      UpdateProjectSettingsSchema.safeParse({
        projectId: "garden",
        expectedRevision: projectsRevision(replaced.projects),
        changes: { autonomy: { fleet: invalid } },
      }).success,
    ).toBe(false);
  }
  expect(await readFile(f.store.path, "utf8")).toBe(bytes);
  await f.patch({
    autonomy: { fleet: Object.fromEntries(FLEET_AUTONOMY_FIELDS.map((field) => [field, null])) },
  });
  const restarted = await new SettingsStore(f.store.path).load();
  expect(restarted.autonomy).toEqual(global);
  expect(restarted.projects.projects[0]!.autonomy).toBeUndefined();
  expect(effectiveFleetAutonomy(restarted.autonomy, restarted.projects.projects[0]!.autonomy)).toEqual(
    global.fleet,
  );
  expect({ ...restarted.projects.projects[0], autonomy: replaced.projects.projects[0]!.autonomy }).toEqual(
    replaced.projects.projects[0],
  );
  expect(restarted.projects.assignments).toEqual(replaced.projects.assignments);
});

it("migrates the existing Clankie release policy once before defaults and never recreates a cleared override", async () => {
  const f = await fixture({ projectId: "clankie", autonomy: { fleet: { closure: "owner" } } });
  const rawBytes = await readFile(f.store.path, "utf8");
  const migrated = await f.store.load();
  expect(migrated.autonomy.fleet).toEqual({ ...FLEET_AUTONOMY_DEFAULTS, closure: "owner" });
  expect(migrated.projects.projects[0]!.autonomy).toEqual({
    fleet: { release: { mode: "time_rule", rule: LEGACY_CLANKIE_RELEASE_RULE } },
  });
  expect(migrated.projects.projects[0]!.workspaces).toEqual([]);
  expect(migrated.projects.projects[1]!.autonomy).toBeUndefined();
  expect(migrated.projects.projects.map((project) => project.id)).toEqual(["clankie", "other"]);
  expect(await readFile(f.store.path, "utf8")).toBe(rawBytes);
  const fenced = await f.store.loadFenced();
  expect(fenced.settings).toEqual(migrated);
  fenced.assertCurrent();
  await f.patch({ autonomy: { fleet: { release: null } } });
  const disk = JSON.parse(await readFile(f.store.path, "utf8"));
  expect(disk.autonomy.fleet).toEqual(migrated.autonomy.fleet);
  expect(disk.projects.projects[0]).not.toHaveProperty("autonomy");
  const restarted = new SettingsStore(f.store.path);
  const cleared = await restarted.load();
  expect(cleared.projects.projects[0]!.autonomy).toBeUndefined();
  expect(effectiveFleetAutonomy(cleared.autonomy, cleared.projects.projects[0]!.autonomy).release).toEqual({
    mode: "owner",
  });
  expect({ ...cleared.projects.projects[0], autonomy: migrated.projects.projects[0]!.autonomy }).toEqual(
    migrated.projects.projects[0],
  );
  expect(cleared.projects.assignments).toEqual(migrated.projects.assignments);
  await restarted.update((current) => current);
  expect(await new SettingsStore(f.store.path).load()).toEqual(cleared);

  const explicit = await fixture({
    projectId: "clankie",
    projectAutonomy: { fleet: { release: { mode: "owner" }, commit: "owner" } },
  });
  expect((await explicit.store.load()).projects.projects[0]!.autonomy).toEqual({
    fleet: { release: { mode: "owner" }, commit: "owner" },
  });
  for (const field of FLEET_WORKING_PREFERENCE_FIELDS) {
    const saved = await fixture({
      projectId: "clankie",
      autonomy: { fleet: { [field]: FLEET_AUTONOMY_DEFAULTS[field] } },
    });
    expect((await saved.store.load()).projects.projects[0]!.autonomy).toBeUndefined();
  }
  const unrelated = await fixture();
  expect((await unrelated.store.load()).projects.projects[0]!.autonomy).toBeUndefined();
});

it("migrates legacy Linear wake and working preferences together without writing during reads", async () => {
  const f = await fixture({ projectId: "clankie", autonomy: { fleet: { closure: "owner" } } });
  const stored = JSON.parse(await readFile(f.store.path, "utf8"));
  stored.linearWebhook = {
    following: true,
    wake: {
      ownerUserIds: ["configured-owner"],
      actors: ["owner"],
      userIds: [],
      notificationTypes: [],
      excludedNotificationTypes: ["issueSubscribed"],
    },
  };
  await writeFile(f.store.path, JSON.stringify(stored));
  const original = await readFile(f.store.path, "utf8");
  const expectedWake = LinearWakeSettingsSchema.parse({ ownerUserIds: ["configured-owner"] });
  const migrated = await f.store.load();
  expect(migrated.linearWebhook).toMatchObject({ following: true, wake: expectedWake });
  expect(migrated.autonomy.fleet).toEqual({ ...FLEET_AUTONOMY_DEFAULTS, closure: "owner" });
  expect(migrated.projects.projects[0]!.autonomy).toEqual({
    fleet: { release: { mode: "time_rule", rule: LEGACY_CLANKIE_RELEASE_RULE } },
  });
  const fenced = await f.store.loadFenced();
  expect(fenced.settings).toEqual(migrated);
  fenced.assertCurrent();
  expect(await readFile(f.store.path, "utf8")).toBe(original);
  await f.patch({ autonomy: { fleet: { release: null } } });
  const persisted = JSON.parse(await readFile(f.store.path, "utf8"));
  expect(persisted.linearWebhook.wake).toEqual(expectedWake);
  expect(persisted.projects.projects[0]).not.toHaveProperty("autonomy");
  const restarted = await new SettingsStore(f.store.path).load();
  expect(restarted.linearWebhook.wake).toEqual(expectedWake);
  expect(restarted.projects.projects[0]!.autonomy).toBeUndefined();
});

it("preserves older wire responses without inventing supported preferences and accepts nullable current policy edits", async () => {
  const f = await fixture();
  const settings = await f.store.load();
  const revision = projectsRevision(settings.projects);
  const oldFleet = { size: "small", models: "efficient", closure: "lead", machineSetup: "owner" };
  const oldSnapshot = FleetSettingsSnapshotSchema.parse({ schemaVersion: 1, revision, fleet: oldFleet });
  expect(oldSnapshot.fleet).toEqual(oldFleet);
  expect(oldSnapshot).not.toHaveProperty("workingPreferences");
  const oldContext = FleetSettingsContextSchema.parse({
    schemaVersion: 1,
    effective: { closure: "lead", machineSetup: "owner" },
    machine: { id: "local", linked: true, targetRevision: revision },
  });
  expect(oldContext.effective).toEqual({ closure: "lead", machineSetup: "owner" });
  expect(oldContext).not.toHaveProperty("workingPreferences");
  const oldProjects = ProjectsSnapshotSchema.parse({
    settings: settings.projects,
    revision,
    autonomyDefaults: { fleet: { closure: "owner", machineSetup: "lead" } },
  });
  expect(oldProjects.autonomyDefaults).toEqual({ fleet: { closure: "owner", machineSetup: "lead" } });
  expect(oldProjects).not.toHaveProperty("workingPreferences");
  for (const [schema, response] of [
    [FleetSettingsSnapshotSchema, oldSnapshot],
    [FleetSettingsContextSchema, oldContext],
    [ProjectsSnapshotSchema, oldProjects],
  ] as const) {
    expect(schema.safeParse({ ...response, workingPreferences: true }).success).toBe(false);
  }
  expect(
    FleetSettingsSnapshotSchema.parse({
      schemaVersion: 1,
      revision,
      fleet: { ...oldFleet, ...settings.autonomy.fleet },
      workingPreferences: true,
    }).fleet,
  ).toEqual({ ...oldFleet, ...settings.autonomy.fleet });
  const clears = Object.fromEntries(FLEET_AUTONOMY_FIELDS.map((field) => [field, null]));
  expect(
    UpdateFleetSettingsSchema.parse({ schemaVersion: 1, expectedRevision: revision, changes: clears })
      .changes,
  ).toEqual(clears);
  expect(
    UpdateFleetSettingsSchema.safeParse({ schemaVersion: 1, expectedRevision: revision, changes: {} })
      .success,
  ).toBe(false);
  expect(
    UpdateFleetSettingsSchema.safeParse({
      schemaVersion: 1,
      expectedRevision: revision,
      changes: { release: { mode: "owner", rule: "This mode cannot retain a rule." } },
    }).success,
  ).toBe(false);
  expect(await f.store.load()).toEqual(settings);
});
