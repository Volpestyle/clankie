import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  SettingsStore,
  setDefaultProjectRole,
  setProjectRole,
  projectRoleForPersona,
} from "@clankie/settings";
import { ProjectSchema } from "@clankie/protocol/projects";
import { PersonaStore } from "../src/captain/personas.ts";
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "persona-project-"));
  roots.push(root);
  const identity = {
    schemaVersion: 1,
    personaId: "alice",
    name: "Alice",
    role: "Sound Designer",
    appearance: { variant: "teal", accessory: "none", shape: "circle" },
    harness: "codex",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const path = join(root, "personas.json");
  writeFileSync(path, JSON.stringify({ schemaVersion: 2, personas: [identity], bindings: [] }));
  return { root, path, identity, settings: new SettingsStore(join(root, "owner", "settings.json")) };
}
it("persists owner assignments before stripping legacy identity roles and keeps the wire projection", async () => {
  const f = fixture();
  const store = new PersonaStore(f.root);
  await store.ready(f.settings);
  expect((await f.settings.load()).projects.assignments).toEqual([
    { projectId: "default", personaId: "alice", role: "Sound Designer" },
  ]);
  const saved = JSON.parse(readFileSync(f.path, "utf8"));
  expect(saved.personas[0]).not.toHaveProperty("role");
  const { role: _role, ...identity } = f.identity;
  expect(saved.personas[0]).toEqual(identity);
  expect(store.all([], () => undefined)[0]).toMatchObject({ name: "Alice", role: "Sound Designer" });
  await store.close();
  const restarted = new PersonaStore(f.root);
  await restarted.ready(f.settings);
  expect(restarted.roles()).toContainEqual({ role: "Sound Designer", builtIn: false, count: 1 });
});
it("retains exact legacy source when owner settings cannot commit or its default project collides", async () => {
  const f = fixture();
  const before = readFileSync(f.path, "utf8");
  vi.spyOn(f.settings, "update").mockRejectedValueOnce(new Error("disk full"));
  const failing = new PersonaStore(f.root);
  await expect(failing.ready(f.settings)).rejects.toThrow("disk full");
  await failing.close();
  expect(readFileSync(f.path, "utf8")).toBe(before);
  await f.settings.update((s) => ({
    ...s,
    projects: { ...s.projects, projects: [ProjectSchema.parse({ id: "default", name: "Owner project" })] },
  }));
  await expect(new PersonaStore(f.root).ready(f.settings)).rejects.toThrow("already exists");
  expect(readFileSync(f.path, "utf8")).toBe(before);
});
it("restarts between settings commit and identity cleanup without restoring a subsequently changed role", async () => {
  const f = fixture();
  const original = readFileSync(f.path, "utf8");
  const store = new PersonaStore(f.root);
  await store.ready(f.settings);
  await f.settings.update((s) => ({
    ...s,
    projects: setDefaultProjectRole(s.projects, "alice", "reviewer"),
  }));
  writeFileSync(f.path, original);
  await store.close();
  const restarted = new PersonaStore(f.root);
  await restarted.ready(f.settings);
  expect(restarted.all([], () => undefined)[0]?.role).toBe("reviewer");
  expect(JSON.parse(readFileSync(f.path, "utf8")).personas[0]).not.toHaveProperty("role");
});
it.each(["default", "repo"])("survives a pending %s assignment across restart", async (projectId) => {
  const f = fixture();
  if (projectId !== "default")
    await f.settings.update((s) => ({
      ...s,
      projects: {
        ...s.projects,
        projects: [ProjectSchema.parse({ id: projectId, name: "Repository" })],
      },
    }));
  const store = new PersonaStore(f.root);
  await store.ready(f.settings);
  vi.spyOn(f.settings, "update").mockRejectedValueOnce(new Error("disk full"));
  await expect(
    store.setProjectRole({ schemaVersion: 1, personaId: "alice", role: "tester", projectId }),
  ).rejects.toThrow("disk full");
  expect(JSON.parse(readFileSync(f.path, "utf8")).personas[0]).not.toHaveProperty("role");
  await store.close();
  const restarted = new PersonaStore(f.root);
  await restarted.ready(f.settings);
  expect(projectRoleForPersona((await f.settings.load()).projects, "alice", projectId)).toBe("tester");
  expect(restarted.all([], () => undefined)[0]?.role).toBe(
    projectId === "default" ? "tester" : "Sound Designer",
  );
  await restarted.setProjectRole({ schemaVersion: 1, personaId: "alice", role: null, projectId });
  expect(projectRoleForPersona((await f.settings.load()).projects, "alice", projectId)).toBeUndefined();
  expect(() => restarted.setRole({ schemaVersion: 1, personaId: "alice", role: "builder" })).toThrow(
    "project role setter",
  );
});
it.each(["default", "repo"])(
  "does not replay a committed %s write over later owner changes",
  async (projectId) => {
    const f = fixture();
    if (projectId !== "default")
      await f.settings.update((s) => ({
        ...s,
        projects: {
          ...s.projects,
          projects: [ProjectSchema.parse({ id: projectId, name: "Repository" })],
        },
      }));
    const store = new PersonaStore(f.root);
    await store.ready(f.settings);
    const pendingPath = join(
      f.root,
      "owner",
      `persona-project-roles-${createHash("sha256").update(f.path).digest("hex")}.pending.json`,
    );
    vi.spyOn(f.settings, "update").mockRejectedValueOnce(new Error("disk full"));
    await expect(
      store.setProjectRole({ schemaVersion: 1, personaId: "alice", role: "tester", projectId }),
    ).rejects.toThrow();
    const pending = readFileSync(pendingPath, "utf8");
    await store.flushProjectRoles();
    await f.settings.update((s) => ({
      ...s,
      projects: setProjectRole(s.projects, "alice", "reviewer", projectId),
    }));
    writeFileSync(pendingPath, pending);
    await store.close();
    const restarted = new PersonaStore(f.root);
    await restarted.ready(f.settings);
    expect(projectRoleForPersona((await f.settings.load()).projects, "alice", projectId)).toBe("reviewer");
  },
);
it("rejects another live journal writer and permits an explicitly closed writer's replacement", async () => {
  const f = fixture();
  const first = new PersonaStore(f.root);
  await first.ready(f.settings);
  const second = new PersonaStore(f.root);
  await expect(second.ready(f.settings)).rejects.toThrow("live or unverifiable writer");
  await second.close();
  await first.close();
  const replacement = new PersonaStore(f.root);
  await replacement.ready(f.settings);
  await replacement.close();
});
it("retains source when readback verification fails after settings commit", async () => {
  const f = fixture();
  const original = readFileSync(f.path, "utf8");
  const load = f.settings.load.bind(f.settings);
  let reads = 0;
  vi.spyOn(f.settings, "load").mockImplementation(async () => {
    reads += 1;
    if (reads === 2) throw new Error("readback failed");
    return load();
  });
  const store = new PersonaStore(f.root);
  await expect(store.ready(f.settings)).rejects.toThrow("readback failed");
  expect(readFileSync(f.path, "utf8")).toBe(original);
  await store.close();
  const replacement = new PersonaStore(f.root);
  await replacement.ready(f.settings);
  expect(replacement.all([], () => undefined)[0]?.role).toBe("Sound Designer");
  await replacement.close();
});
it("does not overwrite a changed identity source between construction and migration", async () => {
  const f = fixture();
  const store = new PersonaStore(f.root);
  const changed = JSON.stringify({
    schemaVersion: 2,
    personas: [{ ...f.identity, name: "Changed" }],
    bindings: [],
  });
  writeFileSync(f.path, changed);
  await expect(store.ready(f.settings)).rejects.toThrow("source changed");
  expect(readFileSync(f.path, "utf8")).toBe(changed);
  await store.close();
});
it("recovers only a demonstrably dead journal writer, without age-based takeover", async () => {
  const f = fixture();
  const first = new PersonaStore(f.root);
  await first.ready(f.settings);
  await first.close();
  const { spawnSync } = await import("node:child_process");
  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
    encoding: "utf8",
  });
  expect(child.status).toBe(0);
  const { mkdirSync } = await import("node:fs");
  const lock = join(
    f.root,
    "owner",
    `persona-project-roles-${createHash("sha256").update(f.path).digest("hex")}.pending.json.lock`,
  );
  mkdirSync(lock);
  writeFileSync(
    join(lock, "owner.json"),
    JSON.stringify({ pid: Number(child.stdout), nonce: "11111111-1111-4111-8111-111111111111" }),
  );
  const replacement = new PersonaStore(f.root);
  await replacement.ready(f.settings);
  expect(JSON.parse(readFileSync(join(lock, "owner.json"), "utf8")).pid).toBe(process.pid);
  await replacement.close();
});
it("does not promote a pending role for an identity that never persisted", async () => {
  const f = fixture();
  const first = new PersonaStore(f.root);
  await first.ready(f.settings);
  await first.close();
  const pendingPath = join(
    f.root,
    "owner",
    `persona-project-roles-${createHash("sha256").update(f.path).digest("hex")}.pending.json`,
  );
  const raw = JSON.stringify([
    { id: "11111111-1111-4111-8111-111111111111", personaId: "missing-agent", role: "builder" },
  ]);
  writeFileSync(pendingPath, raw, { mode: 0o600 });
  const replacement = new PersonaStore(f.root);
  await expect(replacement.ready(f.settings)).rejects.toThrow("no persisted agent identity");
  expect(readFileSync(pendingPath, "utf8")).toBe(raw);
  expect((await f.settings.load()).projects.assignments.some((a) => a.personaId === "missing-agent")).toBe(
    false,
  );
  await replacement.close();
});
