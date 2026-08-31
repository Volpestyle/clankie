import { describe, expect, it } from "vitest";
import { OPERATOR_AGENT_STANCE_MAX_MS } from "@clankie/protocol";
import { createStanceStore } from "../src/captain/stances.ts";

describe("createStanceStore", () => {
  it("hands back what stands and drops it once it lapses", () => {
    let now = 1_700_000_000_000;
    const stances = createStanceStore(() => now);
    stances.state("seat-a", {
      herdrPaneId: "w1:p1",
      pose: "stuck",
      note: "waiting on the build",
      ttlMs: 1_000,
    });

    expect(stances.read("seat-a")).toMatchObject({ pose: "stuck", note: "waiting on the build" });
    now += 1_001;
    expect(stances.read("seat-a")).toBeUndefined();
  });

  it("clamps a statement to the ceiling however long it asked for", () => {
    const now = 1_700_000_000_000;
    const stances = createStanceStore(() => now);
    const stance = stances.state("seat-a", {
      herdrPaneId: "w1:p1",
      pose: "working",
      ttlMs: OPERATOR_AGENT_STANCE_MAX_MS,
    });
    expect(Date.parse(stance.expiresAt) - now).toBe(OPERATOR_AGENT_STANCE_MAX_MS);
  });

  it("keeps one stance per seat, so the latest statement is the one that stands", () => {
    const stances = createStanceStore();
    stances.state("seat-a", { herdrPaneId: "w1:p1", pose: "working" });
    stances.state("seat-a", { herdrPaneId: "w1:p1", pose: "resting" });
    expect(stances.read("seat-a")?.pose).toBe("resting");
    expect(stances.read("seat-b")).toBeUndefined();
  });
});
