import { describe, expect, it, vi } from "vitest";
import { PossessionLease, parsePossessionHolders } from "../src/possession.ts";

describe("possession lease", () => {
  const holders = ["codex-lab", "claude-lab"];

  it("is off until an owner names a holder", () => {
    // Deny-by-default is literal: nothing configured, nothing possessable.
    const lease = new PossessionLease({ allowedHolders: [] });
    expect(() => lease.acquire("codex-lab")).toThrow(/holder_not_allowed/);
    expect(() => lease.assertMayAct(undefined)).toThrow(/not_held/);
  });

  it("refuses a holder that was never named", () => {
    const lease = new PossessionLease({ allowedHolders: holders });
    expect(() => lease.acquire("some-random-agent")).toThrow(/holder_not_allowed/);
  });

  it("gives one holder the body and refuses a second without force", () => {
    const lease = new PossessionLease({ allowedHolders: holders });
    const grant = lease.acquire("codex-lab");
    lease.assertMayAct(grant.token);
    // A race must not decide who is driving.
    expect(() => lease.acquire("claude-lab")).toThrow(/already_held/);
    expect(() => lease.assertMayAct("some-other-token")).toThrow(/held_by_another/);
  });

  it("allows an explicit, logged steal", () => {
    const events: string[] = [];
    const lease = new PossessionLease({
      allowedHolders: holders,
      onEvent: (event) => events.push(`${event.type}:${event.holderId}`),
    });
    lease.acquire("codex-lab");
    const stolen = lease.acquire("claude-lab", { force: true });
    lease.assertMayAct(stolen.token);
    // Possession is never silent.
    expect(events).toContain("stolen:claude-lab");
  });

  it("suspends and resumes the resident loop as the body changes hands", () => {
    const held: boolean[] = [];
    const lease = new PossessionLease({
      allowedHolders: holders,
      onHeldChange: (value) => held.push(value),
    });
    const grant = lease.acquire("codex-lab");
    lease.release(grant.token);
    // Suspend on take, resume on release — not arbitration after the fact.
    expect(held).toEqual([true, false]);
  });

  it("expires rather than holding the body forever", () => {
    let now = 1_000;
    const lease = new PossessionLease({
      allowedHolders: holders,
      ttlMs: 500,
      now: () => now,
      onHeldChange: vi.fn(),
    });
    const grant = lease.acquire("codex-lab");
    now += 501;
    expect(lease.current()).toBeNull();
    expect(() => lease.assertMayAct(grant.token)).toThrow(/not_held/);
  });

  it("ignores a release that does not hold the lease", () => {
    const lease = new PossessionLease({ allowedHolders: holders });
    const grant = lease.acquire("codex-lab");
    lease.release("not-the-token");
    // Someone else's release must not free the body.
    expect(lease.current()?.holderId).toBe("codex-lab");
    lease.release(grant.token);
    expect(lease.current()).toBeNull();
  });

  it("parses the allowlist, treating unset as off", () => {
    expect(parsePossessionHolders(undefined)).toEqual([]);
    expect(parsePossessionHolders(" a , ,b ")).toEqual(["a", "b"]);
  });
});
