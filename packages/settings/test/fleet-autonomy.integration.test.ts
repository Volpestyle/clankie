import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  AutonomySettingsSchema,
  effectiveFleetAutonomy,
  ProjectAutonomySchema,
  ProjectsSnapshotSchema,
  UpdateProjectSettingsSchema,
  type UpdateProjectSettings,
} from "@clankie/protocol";
import { SettingsStore, projectsRevision, updateProjectSettings } from "../src/index.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fleet-autonomy-settings-"));
  roots.push(root);
  const store = new SettingsStore(join(root, "settings.json"));
  await writeFile(
    store.path,
    JSON.stringify({
      schemaVersion: 1,
      fleet: { size: "small", models: "efficient", tools: "off" },
      projects: {
        projects: [
          {
            id: "garden",
            name: "Garden",
            roles: [{ role: "builder", concurrencyCap: 2 }],
            workerCap: 4,
            fleet: { size: "solo" },
            labelRoleMap: [{ label: "implementation", role: "builder" }],
            grants: [{ id: "read", server: "repo", accountId: "personal", tools: [{ name: "read" }] }],
          },
          { id: "other", name: "Other" },
        ],
        assignments: [{ projectId: "garden", personaId: "rook", role: "builder" }],
      },
    }),
  );
  const patch = async (changes: UpdateProjectSettings["changes"], expectedRevision?: string) => {
    const command = UpdateProjectSettingsSchema.parse({
      projectId: "garden",
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
  expect(legacy.autonomy).toEqual({ fleet: { closure: "lead", machineSetup: "lead" } });
  expect(legacy.projects.projects[0]!.autonomy).toBeUndefined();
  expect(legacy.fleet).toMatchObject({ size: "small", models: "efficient", tools: "off" });
  await f.store.update((current) => ({
    ...current,
    autonomy: { fleet: { closure: "owner", machineSetup: "lead" } },
  }));
  await f.patch({ autonomy: { fleet: { machineSetup: "owner" } } });
  const restarted = new SettingsStore(f.store.path);
  const saved = await restarted.load();
  expect(saved.projects.projects[0]!.autonomy).toEqual({ fleet: { machineSetup: "owner" } });
  expect(effectiveFleetAutonomy(saved.autonomy, saved.projects.projects[0]!.autonomy)).toEqual({
    closure: "owner",
    machineSetup: "owner",
  });
  await restarted.update((current) => ({
    ...current,
    autonomy: { fleet: { ...current.autonomy.fleet, closure: "lead" } },
  }));
  const changed = await f.store.load();
  expect(effectiveFleetAutonomy(changed.autonomy, changed.projects.projects[0]!.autonomy)).toEqual({
    closure: "lead",
    machineSetup: "owner",
  });
  expect(JSON.parse(await readFile(f.store.path, "utf8")).autonomy).toEqual({
    fleet: { closure: "lead", machineSetup: "lead" },
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
  expect(effectiveFleetAutonomy(undefined)).toEqual({ closure: "lead", machineSetup: "lead" });
  expect(await f.store.load()).toEqual(before);
});
