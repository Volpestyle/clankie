import { expect, it } from "vitest";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { createProjectMembershipResolver, type ProjectHireLookup } from "../src/project-membership.ts";
import type { ProjectProcessProof } from "../src/project-process-proof.ts";

function fixture() {
  const state = {
    proof: {
      fleet: "default",
      pane: "w1:p1",
      nativeOccupantId: "native-session",
      binding: { socketPath: "/host/socket", session: "default" },
      shell: { pid: 30, startTime: "shell-start" },
      processes: [{ pid: 40, startTime: "agent-start" }],
    } as ProjectProcessProof,
    cwd: "/code/kh2/src",
    live: true,
    hire: { state: "none" } as ProjectHireLookup,
    settings: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "kh2",
          name: "KH2",
          roles: [{ role: "engineer" }],
          workspaces: [{ id: "repo", machineId: "local", platform: "posix", path: "/code/kh2" }],
        },
        {
          id: "rivals",
          name: "Rivals",
          workspaces: [{ id: "repo", machineId: "local", platform: "posix", path: "/code/rivals" }],
        },
      ],
    }),
    canonical: async (path: string) => path,
  };
  const identity = {
    pane: "w1:p1",
    validate: async () => state.live,
    projectProof: async () => structuredClone(state.proof),
  };
  const resolve = createProjectMembershipResolver({
    settings: async () => state.settings,
    hire: async () => state.hire,
    cwd: async () => state.cwd,
    canonical: async (path) => state.canonical(String(path)),
  });
  return { state, identity, resolve: () => resolve(identity) };
}
it("resolves the observed agent cwd afresh, never a session/persona/tracker assignment", async () => {
  const f = fixture();
  expect(await f.resolve()).toMatchObject({ projectId: "kh2" });
  f.state.cwd = "/code/rivals";
  expect(await f.resolve()).toMatchObject({ projectId: "rivals" });
  for (const cwd of ["/code/kh2-other", "/Code/kh2", "/code", "/outside"]) {
    f.state.cwd = cwd;
    expect(await f.resolve()).toBeUndefined();
  }
});
it.each(["fleet", "pane", "machine", "platform", "ambiguous", "alias", "cwd-alias", "relative", "revoked"])(
  "denies %s uncertainty",
  async (kind) => {
    const f = fixture();
    if (kind === "fleet") f.state.proof = { ...f.state.proof, fleet: "pc" };
    if (kind === "pane") f.state.proof = { ...f.state.proof, pane: "w1:p2" };
    if (kind === "machine") f.state.settings.projects[0]!.workspaces[0]!.machineId = "pc";
    if (kind === "platform") f.state.settings.projects[0]!.workspaces[0]!.platform = "windows";
    if (kind === "ambiguous") f.state.settings.projects[1]!.workspaces[0]!.path = "/code";
    if (kind === "alias") f.state.canonical = async (path) => (path === "/code/kh2" ? "/real/kh2" : path);
    if (kind === "cwd-alias")
      f.state.canonical = async (path) => (path === f.state.cwd ? "/real/kh2/src" : path);
    if (kind === "relative") f.state.cwd = "code/kh2";
    if (kind === "revoked") f.state.live = false;
    expect(await f.resolve()).toBeUndefined();
  },
);
it("prefers the actual hire; stale/deleted assignments deny workspace fallback", async () => {
  const f = fixture();
  f.state.hire = { state: "assigned", projectId: "kh2", role: "engineer", occupantId: "native-hire" };
  f.state.cwd = "/code/rivals";
  expect(await f.resolve()).toMatchObject({ projectId: "kh2" });
  f.state.hire = { state: "invalid" };
  expect(await f.resolve()).toBeUndefined();
  f.state.hire = { state: "assigned", projectId: "gone", role: "engineer", occupantId: "native-hire" };
  expect(await f.resolve()).toBeUndefined();
  f.state.hire = { state: "assigned", projectId: "kh2", role: "missing", occupantId: "native-hire" };
  expect(await f.resolve()).toBeUndefined();
});
it.each(["process", "shell", "binding", "workspace"])(
  "denies %s changing during resolution",
  async (kind) => {
    const f = fixture();
    let reads = 0;
    f.state.canonical = async (path) => {
      if (++reads === 1) {
        if (kind === "process")
          f.state.proof = { ...f.state.proof, processes: [{ pid: 40, startTime: "reused" }] };
        if (kind === "shell") f.state.proof = { ...f.state.proof, shell: { pid: 30, startTime: "reused" } };
        if (kind === "binding") f.state.proof = { ...f.state.proof, binding: { socketPath: "/another" } };
        if (kind === "workspace") f.state.cwd = "/outside";
      }
      return path;
    };
    expect(await f.resolve()).toBeUndefined();
  },
);

it.each(["workspace", "project", "role", "hire"])(
  "denies %s removal during pending membership checks",
  async (kind) => {
    const f = fixture();
    if (kind === "role")
      f.state.hire = { state: "assigned", projectId: "kh2", role: "engineer", occupantId: "native-hire" };
    let checks = 0;
    f.identity.validate = async () => {
      if (++checks === 2) {
        if (kind === "workspace") f.state.settings.projects[0]!.workspaces = [];
        if (kind === "project") f.state.settings.projects = [];
        if (kind === "role") f.state.settings.projects[0]!.roles = [];
        if (kind === "hire") f.state.hire = { state: "invalid" };
      }
      return true;
    };
    expect(await f.resolve()).toBeUndefined();
  },
);

it("requires an actual hire for a registered private app-server and never falls back to its pane cwd", async () => {
  const f = fixture();
  f.state.proof = { ...f.state.proof, privateSeat: true };
  expect(await f.resolve()).toBeUndefined();
  f.state.hire = { state: "assigned", projectId: "kh2", role: "engineer", occupantId: "native-hire" };
  expect(await f.resolve()).toMatchObject({ projectId: "kh2" });
  f.state.hire = { state: "invalid" };
  expect(await f.resolve()).toBeUndefined();
});

it("rechecks settings and hire state after a slow final process proof, never before it settles", async () => {
  for (const changed of ["settings", "hire"] as const) {
    const f = fixture();
    let reads = 0;
    let finish!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const observed = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.identity.projectProof = async () => {
      if (++reads === 2) {
        started();
        await pending;
      }
      return structuredClone(f.state.proof);
    };
    const result = f.resolve();
    await observed;
    if (changed === "settings") f.state.settings.projects = [];
    else f.state.hire = { state: "invalid" };
    finish();
    expect(await result).toBeUndefined();
  }
});
