import { describe, expect, test } from "vitest";
import { machineAccessAllows } from "@clankie/protocol";
import { RemoteLeadDelegations, type RemoteLeadBinding } from "../src/remote-lead-delegations.ts";
import type { ProjectProcessProof } from "../src/project-process-proof.ts";
import type { LocalFleetIdentity } from "../src/local-fleet-link.ts";

// This exercises the delegation boundary's host-proof contract. It does not
// claim to verify Windows kernel observation or native harness launch.
const binding: RemoteLeadBinding = {
  fleet: "pc", machine: "pc", pane: "w1:p1", conversationId: "conv-project",
  nativeOccupantId: "session-original", shell: { pid: 123, startTime: "2026-10-09T00:00:00.0000000Z" },
};
const proof: ProjectProcessProof = {
  fleet: binding.fleet, pane: binding.pane, nativeOccupantId: binding.nativeOccupantId,
  shell: binding.shell, binding: { socketPath: "pipe-original", session: "default" },
  processes: [{ pid: 456, startTime: "2026-10-09T00:00:01.0000000Z" }],
  workspace: { machineId: "pc", platform: "windows", canonicalPath: "C:\\scratch" },
};
const identity = (observed: ProjectProcessProof): LocalFleetIdentity => ({
  fleet: observed.fleet, pane: observed.pane,
  current: () => true, validate: async () => true, projectProof: async () => observed,
});
const request = (token: string) => new Request("http://localhost/v1/fleet/lead/mcp", {
  headers: { authorization: `Bearer ${token}` },
});

describe("remote project lead delegation trust boundary", () => {
  test("a launch secret needs the exact host-proven machine, pane, occupant and process lifetime", async () => {
    const grants = new RemoteLeadDelegations(async () => {});
    const issued = await grants.issue(binding);
    const auth = await grants.authorize(request(issued.token), identity(proof));
    expect(auth?.binding.conversationId).toBe(binding.conversationId);
    expect(await auth?.authorize()).toBe(true);
    for (const changed of [
      { ...proof, fleet: "other" }, { ...proof, pane: "w1:p2" },
      { ...proof, nativeOccupantId: "session-replacement" },
      { ...proof, nativeSessionPending: true as const },
      { ...proof, workspace: { ...proof.workspace!, machineId: "other" } },
      { ...proof, shell: { ...proof.shell, startTime: "2026-10-09T00:00:02.0000000Z" } },
    ]) expect(await grants.authorize(request(issued.token), identity(changed))).toBeUndefined();
    expect(await grants.authorize(request(issued.token), undefined)).toBeUndefined();
    expect(await grants.authorize(request("a".repeat(43)), identity(proof))).toBeUndefined();
    grants.close();
  });

  test("revocation invalidates retained authority and a formerly valid secret immediately", async () => {
    const grants = new RemoteLeadDelegations(async () => {});
    const issued = await grants.issue(binding);
    const auth = (await grants.authorize(request(issued.token), identity(proof)))!;
    expect(grants.revoke(issued.id)).toBe(true);
    expect(auth.signal.aborted).toBe(true);
    expect(auth.current()).toBe(false);
    expect(await auth.authorize()).toBe(false);
    expect(await grants.authorize(request(issued.token), identity(proof))).toBeUndefined();
    expect(await new RemoteLeadDelegations(async () => {}).authorize(request(issued.token), identity(proof))).toBeUndefined();
  });

  test("downgrade and unavailable policy refuse existing grants, not just new launches", async () => {
    let level: "workers" | "portal" = "workers";
    let available = true;
    const grants = new RemoteLeadDelegations(async () => {
      if (!available || !machineAccessAllows(level, "workers")) throw new Error("access refused");
    });
    const issued = await grants.issue(binding);
    const auth = (await grants.authorize(request(issued.token), identity(proof)))!;
    level = "portal";
    await expect(auth.authorize()).rejects.toThrow("access refused");
    await expect(grants.issue(binding)).rejects.toThrow("access refused");
    level = "workers";
    available = false;
    await expect(grants.authorize(request(issued.token), identity(proof))).rejects.toThrow("access refused");
    grants.close();
  });

  test("revocation during an asynchronous proof cannot admit the delayed request", async () => {
    const grants = new RemoteLeadDelegations(async () => {});
    const issued = await grants.issue(binding);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const pending = grants.authorize(request(issued.token), {
      ...identity(proof), projectProof: async () => { await waiting; return proof; },
    });
    grants.revoke(issued.id);
    release();
    expect(await pending).toBeUndefined();
  });
});
