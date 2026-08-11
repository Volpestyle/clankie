import { describe, expect, it } from "vitest";
import { battleModeForOutcome } from "../src/index.ts";

describe("battleModeForOutcome", () => {
  it("maps every engine-defined gBattleOutcome to a mode without throwing", () => {
    expect(battleModeForOutcome(0)).toBe("battle");
    expect(battleModeForOutcome(1)).toBe("battle_won");
    expect(battleModeForOutcome(2)).toBe("battle_lost");
    expect(battleModeForOutcome(9)).toBe("battle_lost");
    // Drew, ran, teleported, opponent fled, caught, out of Safari Balls: the
    // battle ends but its exit text is still resolving on screen. A successful
    // "Run" once threw here and wedged every subsequent action while
    // "Got away safely!" waited for an A press that could never be delivered.
    for (const outcome of [3, 4, 5, 6, 7, 8, 10]) {
      expect(battleModeForOutcome(outcome)).toBe("battle");
    }
  });
});
