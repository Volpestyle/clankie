import { describe, expect, it } from "vitest";
import {
  formatHerdrJumpResult,
  herdrPaneRefAtColumn,
  jumpToHerdrAgent,
} from "../src/session/herdr-report.ts";

const ESC = String.fromCharCode(27);
const line = "- w18:p1J (VUH-1025) — idle is a question";

describe("herdr pane refs in the transcript", () => {
  it("finds the id the click landed on", () => {
    expect(herdrPaneRefAtColumn(line, 2)).toBe("w18:p1J");
    expect(herdrPaneRefAtColumn(line, 8)).toBe("w18:p1J");
    expect(herdrPaneRefAtColumn(line, 1)).toBeUndefined();
    expect(herdrPaneRefAtColumn(line, 9)).toBeUndefined();
    expect(herdrPaneRefAtColumn("nothing to jump to", 4)).toBeUndefined();
  });

  it("counts columns past styling and wide glyphs", () => {
    expect(herdrPaneRefAtColumn(`${ESC}[36m${line}${ESC}[0m`, 3)).toBe("w18:p1J");
    expect(herdrPaneRefAtColumn("🐟 w19:p1", 3)).toBe("w19:p1");
  });
});

describe("jumping to a herdr agent", () => {
  const env = { HERDR_ENV: "1" } as NodeJS.ProcessEnv;

  it("focuses the target through the herdr CLI", async () => {
    const calls: string[][] = [];
    const result = await jumpToHerdrAgent("w18:p1J", {
      env,
      runCommand: (command, args) => {
        calls.push([command, ...args]);
        return Promise.resolve({ stdout: "", stderr: "" });
      },
    });
    expect(result).toEqual({ outcome: "ok", target: "w18:p1J" });
    expect(calls).toEqual([["herdr", "agent", "focus", "w18:p1J"]]);
    expect(formatHerdrJumpResult(result).tone).toBe("success");
  });

  it("reports herdr's own refusal", async () => {
    const failure = Object.assign(new Error("Command failed: herdr agent focus w18:p99"), {
      stderr: '{"error":{"code":"agent_not_found","message":"agent target w18:p99 not found"},"id":"x"}\n',
      stdout: "",
    });
    const result = await jumpToHerdrAgent("w18:p99", {
      env,
      runCommand: () => Promise.reject(failure),
    });
    expect(formatHerdrJumpResult(result)).toEqual({
      text: "Cannot jump (agent target w18:p99 not found).",
      tone: "error",
    });
  });

  it("stays inert outside herdr", async () => {
    const result = await jumpToHerdrAgent("w18:p1J", {
      env: {} as NodeJS.ProcessEnv,
      runCommand: () => Promise.reject(new Error("should not run")),
    });
    expect(result).toEqual({ outcome: "skipped", reason: "not_in_herdr" });
  });
});
