import { OPERATOR_CONVERSATION_TOOL_DETAIL_MAX } from "@clankie/protocol";
import { describe, expect, it } from "vitest";
import {
  formatOperatorToolDetail,
  formatOperatorToolResult,
  operatorSkillName,
  resolveOperatorPrompt,
} from "../src/captain/captain.ts";

describe("operator tool detail", () => {
  it("redacts secrets and marks bounded output", () => {
    expect(formatOperatorToolDetail({ apiKey: "secret", path: "README.md" })).toBe(
      '{\n  "apiKey": "[REDACTED]",\n  "path": "README.md"\n}',
    );

    const detail = formatOperatorToolDetail("x".repeat(OPERATOR_CONVERSATION_TOOL_DETAIL_MAX + 1));
    expect(detail).toHaveLength(OPERATOR_CONVERSATION_TOOL_DETAIL_MAX);
    expect(detail).toMatch(/… truncated$/u);
  });

  it("renders model-visible result content without the Pi envelope or escaped newlines", () => {
    expect(
      formatOperatorToolResult({
        content: [
          { type: "text", text: "\u001B[32mWORKSPACE w12\u001B[0m\n  tab w12:t1" },
          { type: "image", data: "base64", mimeType: "image/png" },
        ],
        details: { noisy: true },
      }),
    ).toBe("WORKSPACE w12\n  tab w12:t1\n\n[image: image/png]");
  });

  it("recognizes named skill reads without relabeling ordinary files", () => {
    expect(operatorSkillName("read", { path: "/Users/james/.agents/skills/herdr-lead/SKILL.md" })).toBe(
      "herdr-lead",
    );
    expect(operatorSkillName("read", { file_path: ".agents/skills/trace-clankie/SKILL.md" })).toBe(
      "trace-clankie",
    );
    expect(operatorSkillName("read", { path: "README.md" })).toBeUndefined();
    expect(operatorSkillName("bash", { path: "/tmp/fake/SKILL.md" })).toBeUndefined();
  });

  it("translates only exact, model-invocable operator slash skills", () => {
    const skills = [
      { name: "ponytail", disableModelInvocation: false },
      { name: "hidden", disableModelInvocation: true },
    ];

    expect(resolveOperatorPrompt("/ponytail fix this", skills)).toEqual({
      prompt: "/skill:ponytail fix this",
      skillName: "ponytail",
    });
    expect(resolveOperatorPrompt("/skill:ponytail fix this", skills).prompt).toBe("/skill:ponytail fix this");
    expect(resolveOperatorPrompt("/pony fix this", skills).skillName).toBeUndefined();
    expect(resolveOperatorPrompt("/hidden", skills).skillName).toBeUndefined();
    const seatedPrompt = resolveOperatorPrompt("/ponytail fix this", skills, "w3:p2J").prompt;
    expect(seatedPrompt).toMatch(/^\/skill:ponytail /u);
    expect(seatedPrompt).toContain("w3:p2J");
    expect(seatedPrompt.endsWith("fix this")).toBe(true);
  });
});
