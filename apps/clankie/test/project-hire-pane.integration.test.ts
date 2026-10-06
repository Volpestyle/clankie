import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { SpawnOperatorSeatSchema } from "@clankie/protocol";
import { ProjectsSettingsSchema } from "@clankie/protocol/projects";
import { HerdrWatchStore } from "../src/captain/herdr-watch.ts";
import { ProjectHires, type ProjectHireProcessProof } from "../src/captain/project-hires.ts";

// The actual failed PC hire supplied these pane/process identities. This test
// exercises the persisted assignment boundary, not a live Windows process proof.
const evidenceRoot = new URL(
  "../../../docs/testing/2026-10-06-remote-native-channels/live/2e1c08be/",
  import.meta.url,
);
const census = JSON.parse(await readFile(new URL("tracker-and-process-proof.json", evidenceRoot), "utf8"));
const settlement = JSON.parse(
  await readFile(new URL("fresh-failed-hire-abandoned.json", evidenceRoot), "utf8"),
);
const owned = census.owned.find((entry: { pane: string }) => entry.pane === "wC:p2");
const address = settlement.evidence.allocation.paneId;
const hostPane = owned.pane;
const input = SpawnOperatorSeatSchema.parse({
  schemaVersion: 1,
  fleet: settlement.evidence.target.fleet,
  harness: "codex",
  role: "tester",
  title: "Ada",
  workingDirectory: JSON.parse(settlement.evidence.receiptKey)[2],
});
const settings = ProjectsSettingsSchema.parse({ projects: [{ id: "game", name: "Game" }] });
const processProof: ProjectHireProcessProof = {
  nativeOccupantId: "fixture-native-session",
  fleet: input.fleet!,
  pane: address,
  binding: { socketPath: "fixture-herdr.sock", session: settlement.evidence.target.session },
  shell: { pid: owned.processes[0].pid, startTime: owned.processes[0].created },
  processes: owned.processes
    .filter((process: { name: string }) => process.name === "codex.exe")
    .map((process: { pid: number; created: string }) => ({ pid: process.pid, startTime: process.created })),
};
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(pane = address, retainProof = true) {
  const root = await mkdtemp(join(tmpdir(), "project-hire-pane-"));
  roots.push(root);
  const path = join(root, "watches.json");
  const ledger = new ProjectHires(`${path}.project-hires.json`);
  const allocation = ledger.reserve(settings, "game", input);
  ledger.launch(allocation.id, settings);
  ledger.pane(allocation.id, pane);
  ledger.observe(
    allocation.id,
    owned.terminal,
    processProof.nativeOccupantId,
    retainProof ? { ...processProof, pane } : undefined,
  );
  ledger.confirmed(allocation.id);
  const store = new HerdrWatchStore(path);
  return { store, ledgerPath: `${path}.project-hires.json` };
}

it("recognizes a retained remote hire through both pane address forms after reload without changing its journal", async () => {
  const { store, ledgerPath } = await fixture();
  try {
    const original = await readFile(ledgerPath, "utf8");
    const candidate = store.projectHireMembershipCandidate("pc", address);
    expect(candidate.state).toBe("confirmed");
    if (candidate.state !== "confirmed") throw new Error("Missing confirmed fixture assignment");
    const assignment = store.projectHireAssignment("pc", address, processProof);
    expect(assignment).toMatchObject({ state: "assigned", projectId: "game", role: "tester" });
    for (const pane of [hostPane, address]) {
      expect(store.projectHireMembershipCandidate("pc", pane)).toEqual(candidate);
      for (const proofPane of [hostPane, address]) {
        const proof = { ...processProof, pane: proofPane };
        expect(store.projectHireAssignment("pc", pane, proof)).toEqual(assignment);
        expect(store.confirmedProjectHireAssignment("pc", pane, candidate.revision, proof)).toEqual(
          assignment,
        );
      }
    }
    expect(await readFile(ledgerPath, "utf8")).toBe(original);
  } finally {
    store.close();
  }
});

it.each([
  [address, false],
  [hostPane, false],
  [hostPane, true],
])(
  "keeps legacy or unproved allocation %s (original proof %s) fenced without a workspace fallback",
  async (allocationPane, retainProof) => {
    const { store, ledgerPath } = await fixture(allocationPane, retainProof);
    try {
      const original = await readFile(ledgerPath, "utf8");
      for (const pane of [hostPane, address]) {
        expect(store.projectHireMembershipCandidate("pc", pane)).toEqual({ state: "unconfirmed" });
        for (const proofPane of [hostPane, address]) {
          const proof = { ...processProof, pane: proofPane };
          expect(store.projectHireAssignment("pc", pane, proof)).toEqual({ state: "invalid" });
          expect(store.confirmedProjectHireAssignment("pc", pane, "claimed-revision", proof)).toEqual({
            state: "invalid",
          });
        }
      }
      expect(await readFile(ledgerPath, "utf8")).toBe(original);
    } finally {
      store.close();
    }
  },
);

it("refuses other fleets, panes, stale lifetimes/bindings and revisions without adopting or rewriting the original", async () => {
  const { store, ledgerPath } = await fixture();
  try {
    const original = await readFile(ledgerPath, "utf8");
    const candidate = store.projectHireMembershipCandidate("pc", hostPane);
    expect(candidate.state).toBe("confirmed");
    if (candidate.state !== "confirmed") throw new Error("Missing confirmed fixture assignment");
    for (const pane of ["other/wC:p2", "pc/other/wC:p2", "pc/wC:p2/extra"])
      expect(store.projectHireMembershipCandidate("pc", pane)).toEqual({ state: "none" });
    expect(store.projectHireMembershipCandidate("other", hostPane)).toEqual({ state: "none" });
    for (const proof of [
      { ...processProof, fleet: "other" },
      { ...processProof, pane: "other/wC:p2" },
      { ...processProof, pane: "wC:p3" },
      { ...processProof, nativeOccupantId: "replacement-session" },
      { ...processProof, shell: { ...processProof.shell, startTime: "replacement-shell" } },
      { ...processProof, processes: [{ ...processProof.processes[0]!, startTime: "reused-pid" }] },
      { ...processProof, binding: { ...processProof.binding, socketPath: "replacement.sock" } },
    ]) {
      expect(store.projectHireAssignment("pc", hostPane, proof)).toEqual({ state: "invalid" });
      expect(store.confirmedProjectHireAssignment("pc", hostPane, candidate.revision, proof)).toEqual({
        state: "invalid",
      });
    }
    expect(store.confirmedProjectHireAssignment("pc", hostPane, "stale-revision", processProof)).toEqual({
      state: "invalid",
    });
    expect(await readFile(ledgerPath, "utf8")).toBe(original);
  } finally {
    store.close();
  }
});
