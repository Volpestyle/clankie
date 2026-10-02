import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateFreePlayJournal } from "../src/free-play-evaluator.ts";

interface Case {
  id: string;
  journal: unknown[];
  voiceReceipts: unknown[];
  lifecycleEvents: unknown[];
  expected: { narration: string; movement: string; terminalSource: string };
}
const cases = JSON.parse(
  readFileSync(new URL("./fixtures/free-play-corpus.json", import.meta.url), "utf8"),
) as Case[];
const jsonl = (lines: unknown[]) => lines.map((line) => JSON.stringify(line)).join("\n");

describe("offline evidence calibration corpus", () => {
  it("has a nonempty, uniquely named set of positive and negative controls", () => {
    expect(cases.length).toBeGreaterThanOrEqual(6);
    expect(new Set(cases.map((entry) => entry.id)).size).toBe(cases.length);
    expect(cases.map((entry) => entry.expected.movement)).toEqual(
      expect.arrayContaining(["effective", "ineffective", "unknown"]),
    );
    expect(cases.map((entry) => entry.expected.narration)).toEqual(
      expect.arrayContaining(["played", "attempted_no_receipt", "suppressed"]),
    );
  });
  it.each(cases)("$id", ({ journal, voiceReceipts, lifecycleEvents, expected }) => {
    const report = evaluateFreePlayJournal({
      journal: jsonl(journal),
      voiceReceipts: jsonl(voiceReceipts),
      lifecycleEvents: jsonl(lifecycleEvents),
    });
    expect(report.aggregate.turns).toBe(1);
    expect(report.turns[0]?.verdicts.narration).toBe(expected.narration);
    expect(report.turns[0]?.verdicts.movementEffectiveness).toBe(expected.movement);
    expect(report.run.terminal.source).toBe(expected.terminalSource);
  });
});
