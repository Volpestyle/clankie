import { describe, expect, it } from "vitest";
import { OPERATOR_SEAT_HARNESSES } from "@clankie/protocol";
import { ProjectsSettingsSchema, ProjectSchema, ProjectRoleSchema } from "@clankie/protocol/projects";
import {
  migratePersonaRoles,
  projectRoleForPersona,
  projectsRevision,
  resolveProjectMembership,
  setDefaultProjectRole,
} from "../src/projects.ts";
import { emptySettings } from "../src/schema.ts";
const source = "a".repeat(64);
const legacy = [
  { personaId: "alice", role: "Sound Designer" },
  { personaId: "bob", role: "BUILDER" },
];
const empty = () => ProjectsSettingsSchema.parse({});
const project = (id: string, path = "/code/team") =>
  ProjectSchema.parse({
    id,
    name: id,
    roles: [{ role: "builder" }],
    workspaces: [{ id: "repo", machineId: "local", platform: "posix", path }],
  });

describe("owner projects", () => {
  it("accepts every canonical hire harness as a role default without widening the executable allow-list", () => {
    expect(OPERATOR_SEAT_HARNESSES).toContain("opencode");
    for (const harness of OPERATOR_SEAT_HARNESSES) {
      expect(ProjectRoleSchema.parse({ role: "builder", harness }).harness).toBe(harness);
    }
    expect(ProjectRoleSchema.safeParse({ role: "builder", harness: "unlisted-harness" }).success).toBe(false);
  });

  it("defaults old settings to no projects without copying fleet authority", () => {
    expect(emptySettings().projects).toEqual(empty());
  });
  it("preserves custom and built-in roles in a default project without granting membership", () => {
    const next = migratePersonaRoles(empty(), source, legacy);
    expect(projectRoleForPersona(next, "alice")).toBe("Sound Designer");
    expect(projectRoleForPersona(next, "bob")).toBe("builder");
    expect(next.projects[0]).toMatchObject({ workspaces: [], grants: [] });
    expect(
      resolveProjectMembership(next, {
        occupantId: "agent",
        workspace: { machineId: "local", platform: "posix", canonicalPath: "/code" },
      }),
    ).toEqual({ outcome: "unassigned" });
    expect(migratePersonaRoles(next, source, legacy)).toEqual(next);
  });
  it("fails on default-project collision and different migration source", () => {
    expect(() =>
      migratePersonaRoles(ProjectsSettingsSchema.parse({ projects: [project("default")] }), source, legacy),
    ).toThrow("already exists");
    expect(() =>
      migratePersonaRoles(migratePersonaRoles(empty(), source, legacy), "b".repeat(64), legacy),
    ).toThrow("conflicts");
  });
  it("does not resurrect a migrated role after operator edits and restart", () => {
    const migrated = migratePersonaRoles(empty(), source, legacy);
    const edited = setDefaultProjectRole(migrated, "alice", null);
    expect(projectRoleForPersona(migratePersonaRoles(edited, source, legacy), "alice")).toBeUndefined();
    expect(projectsRevision(edited)).not.toBe(projectsRevision(migrated));
  });
  it("requires explicit project context rather than picking a first association", () => {
    const settings = ProjectsSettingsSchema.parse({
      projects: [project("one"), project("two")],
      assignments: [
        { projectId: "one", personaId: "alice", role: "builder" },
        { projectId: "two", personaId: "alice", role: "builder" },
      ],
    });
    expect(projectRoleForPersona(settings, "alice")).toBeUndefined();
    expect(projectRoleForPersona(settings, "alice", "two")).toBe("builder");
  });
  it("rejects duplicate roles, assignments, unknown role and tracker workspace", () => {
    expect(() =>
      ProjectSchema.parse({
        id: "one",
        name: "One",
        roles: [{ role: "Sound Designer" }, { role: "sound designer" }],
      }),
    ).toThrow();
    expect(() =>
      ProjectSchema.parse({
        id: "one",
        name: "One",
        trackerRef: { workspaceId: "missing", path: ".clankie/tracking.json" },
      }),
    ).toThrow();
    expect(() =>
      ProjectsSettingsSchema.parse({
        projects: [project("one")],
        assignments: [{ projectId: "one", personaId: "alice", role: "reviewer" }],
      }),
    ).toThrow();
    expect(() =>
      ProjectsSettingsSchema.parse({
        projects: [project("one")],
        assignments: Array(2).fill({ projectId: "one", personaId: "alice", role: "builder" }),
      }),
    ).toThrow();
  });
  it("rejects nested overlapping projects and does not inherit sibling worktrees", () => {
    const settings = ProjectsSettingsSchema.parse({
      projects: [project("one"), project("two", "/code/team/nested")],
    });
    const input = {
      occupantId: "agent",
      workspace: { machineId: "local", platform: "posix" as const, canonicalPath: "/code/team/nested/src" },
    };
    expect(resolveProjectMembership(settings, input)).toEqual({ outcome: "ambiguous" });
    expect(
      resolveProjectMembership(settings, {
        ...input,
        workspace: { ...input.workspace, canonicalPath: "/code/team-wt" },
      }),
    ).toEqual({ outcome: "unassigned" });
    expect(
      resolveProjectMembership(settings, {
        ...input,
        workspace: { ...input.workspace, canonicalPath: "/code/team/../other" },
      }),
    ).toEqual({ outcome: "unverified_workspace" });
  });
  it("uses current exact host hire before cwd and fails stale assignments without fallback", () => {
    const settings = ProjectsSettingsSchema.parse({ projects: [project("one"), project("two", "/other")] });
    const input = {
      occupantId: "agent",
      hire: { occupantId: "agent", projectId: "two", role: "builder" },
      workspace: { machineId: "local", platform: "posix" as const, canonicalPath: "/code/team" },
    };
    expect(resolveProjectMembership(settings, input)).toMatchObject({
      outcome: "member",
      projectId: "two",
      source: "hire",
    });
    expect(
      resolveProjectMembership(settings, { ...input, hire: { ...input.hire, occupantId: "old" } }),
    ).toEqual({ outcome: "invalid_assignment" });
  });
});
