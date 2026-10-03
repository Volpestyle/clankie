import { expect, it } from "vitest";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { inspectFleetMembership } from "../src/fleet-membership-doctor.ts";
import type { ProjectHireLookup } from "../src/project-membership.ts";
import type { ProjectProcessProof } from "../src/project-process-proof.ts";

function fixture() {
  const state = {
    connected: true,
    reads: 0,
    proof: {
      fleet: "kh2",
      pane: "w1:p1",
      nativeOccupantId: "session-1",
      binding: { socketPath: "host-socket", session: "kh2" },
      shell: { pid: 10, startTime: "shell" },
      processes: [{ pid: 20, startTime: "native" }],
      workspace: { machineId: "kh2", platform: "windows", canonicalPath: "C:\\code\\kh2\\src" },
    } as ProjectProcessProof | undefined,
    hire: { state: "none" } as ProjectHireLookup,
    settings: ProjectsSettingsSchema.parse({
      projects: [
        {
          id: "game",
          name: "Game",
          workspaces: [{ id: "repo", machineId: "kh2", platform: "windows", path: "C:\\code\\kh2" }],
        },
      ],
    }),
    onRead: (_count: number) => {},
  };
  const options = {
    machine: "kh2",
    supportedHarnesses: ["claude", "codex"],
    connected: async () => state.connected,
    panes: async () => [{ pane: "w1:p1", harness: "codex" }],
    observe: async () => {
      state.onRead(++state.reads);
      return structuredClone(state.proof);
    },
    settings: async () => structuredClone(state.settings),
    hire: async () => structuredClone(state.hire),
    remoteCanonical: async (_machine: string, path: string) => path,
  };
  return { state, options, run: () => inspectFleetMembership(options) };
}
it("reports host eligibility and actual cwd without claiming a native bridge or tool catalog", async () => {
  const f = fixture();
  expect(await f.run()).toMatchObject({
    machine: "kh2",
    evidence: "host-process",
    nativeTools: "not-verified",
    truncated: false,
    totalPanes: 1,
    panes: [
      {
        projectId: "game",
        eligibility: "eligible",
        nativeSession: "observed",
        cwd: "C:\\code\\kh2\\src",
        hire: "none",
        harnessSource: "herdr-inventory",
      },
    ],
  });
});
it("pending native reporting permits only owner-started eligibility", async () => {
  const f = fixture();
  f.state.proof = { ...f.state.proof!, nativeSessionPending: true };
  expect((await f.run()).panes[0]).toMatchObject({ eligibility: "eligible", nativeSession: "pending" });
  f.state.hire = { state: "assigned", projectId: "game", occupantId: "hire" };
  expect((await f.run()).panes[0]).toMatchObject({ eligibility: "ineligible", nativeSession: "pending" });
});
it("stale hires deny workspace fallback and private unbound seats are distinct", async () => {
  const f = fixture();
  f.state.hire = { state: "invalid" };
  expect((await f.run()).panes[0]).toMatchObject({ eligibility: "stale", hire: "invalid" });
  f.state.hire = { state: "none" };
  f.state.proof = { ...f.state.proof!, privateSeat: true };
  expect((await f.run()).panes[0]).toMatchObject({ eligibility: "private-unbound" });
});
it("unsupported and missing native proof never reuse inventory cwd or infer tools", async () => {
  const f = fixture();
  f.state.proof = undefined;
  expect((await f.run()).panes[0]).toMatchObject({ eligibility: "unproven", nativeSession: "unavailable" });
  expect((await f.run()).panes[0]).not.toHaveProperty("cwd");
  f.options.supportedHarnesses = ["claude"];
  expect((await f.run()).panes[0]).toMatchObject({ eligibility: "unsupported" });
});
it.each(["occupant", "settings", "hire", "failure"])("fences final %s changes", async (kind) => {
  const f = fixture();
  f.state.onRead = (count) => {
    if (count !== 4) return;
    if (kind === "occupant")
      f.state.proof = { ...f.state.proof!, processes: [{ pid: 21, startTime: "replacement" }] };
    if (kind === "settings") f.state.settings.projects = [];
    if (kind === "hire") f.state.hire = { state: "invalid" };
    if (kind === "failure") throw new Error("offline");
  };
  const pane = (await f.run()).panes[0]!;
  expect(pane.eligibility).toBe(kind === "failure" ? "unproven" : "stale");
  expect(pane).not.toHaveProperty("projectId");
  expect(pane).not.toHaveProperty("cwd");
});
it("missing approved workspace or wrong machine is ineligible, never a broad parent shortcut", async () => {
  const f = fixture();
  f.options.remoteCanonical = async (_machine, path) => (path === "C:\\code\\kh2" ? "C:\\other" : path);
  expect((await f.run()).panes[0]).toMatchObject({ eligibility: "ineligible" });
  f.state.proof = {
    ...f.state.proof!,
    workspace: { machineId: "other", platform: "windows", canonicalPath: "C:\\code\\kh2" },
  };
  expect((await f.run()).panes[0]).toMatchObject({ eligibility: "ineligible" });
});
it("rejects unregistered or changed fleets before probing and bounds the inventory", async () => {
  const f = fixture();
  f.state.connected = false;
  await expect(f.run()).rejects.toThrow("Configured fleet unavailable");
  expect(f.state.reads).toBe(0);
  f.state.connected = true;
  f.options.supportedHarnesses = [];
  f.options.panes = async () => Array.from({ length: 65 }, (_, i) => ({ pane: `w1:p${i}`, harness: "pi" }));
  expect(await f.run()).toMatchObject({ totalPanes: 65, truncated: true });
  expect((await f.run()).panes).toHaveLength(64);
});
