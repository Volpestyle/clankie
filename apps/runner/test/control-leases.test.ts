import { describe, expect, it } from "vitest";
import { ControlLeaseManager } from "../src/control-leases.ts";

describe("ControlLeaseManager", () => {
  it("allows one controlling principal and rejects concurrent takeover", () => {
    const leases = new ControlLeaseManager();
    const lease = leases.acquire("terminal-1", "human-a", 60_000);

    expect(leases.assert("terminal-1", lease.id)).toMatchObject({ principalId: "human-a" });
    expect(() => leases.acquire("terminal-1", "human-b", 60_000)).toThrow(/controlled by human-a/);
  });

  it("expires stale control and allows a new principal", () => {
    const leases = new ControlLeaseManager();
    const old = leases.acquire("terminal-1", "human-a", 1);
    leases.expireStale(Date.parse(old.expiresAt) + 1);

    expect(() => leases.assert("terminal-1", old.id)).toThrow(/valid control lease/);
    expect(leases.acquire("terminal-1", "human-b").principalId).toBe("human-b");
  });
});
