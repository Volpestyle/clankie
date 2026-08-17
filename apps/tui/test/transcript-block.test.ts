import { visibleWidth, type MarkdownTheme } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  ClankieTranscriptMarkdownBlock,
  parseTranscriptMarkdown,
  type ClankieTranscriptBlockTheme,
} from "../src/face/clankie-transcript-block.ts";

const plain = (text: string) => text;
const markdownTheme: MarkdownTheme = {
  bold: plain,
  code: plain,
  codeBlock: plain,
  codeBlockBorder: plain,
  heading: plain,
  hr: plain,
  italic: plain,
  link: plain,
  linkUrl: plain,
  listBullet: plain,
  quote: plain,
  quoteBorder: plain,
  strikethrough: plain,
  underline: plain,
};
const theme: ClankieTranscriptBlockTheme = {
  bold: plain,
  cyan: plain,
  dim: plain,
  green: plain,
  loadingGlyph: () => "⠃",
  markdown: markdownTheme,
  red: plain,
  yellow: plain,
};

describe("parseTranscriptMarkdown", () => {
  it("lifts bold first-line titles, preserves the body, and classifies tool titles", () => {
    const parsed = parseTranscriptMarkdown("**Tool: bash - completed**\n\n- stdout: ok");
    expect(parsed.title).toBe("Tool: bash - completed");
    expect(parsed.body).toBe("- stdout: ok");
    expect(parsed.tone).toBe("tool");
  });

  it("classifies skill titles distinctly from tools", () => {
    expect(parseTranscriptMarkdown("**Skill: herdr - running**\n\nloading").tone).toBe("skill");
  });
});

describe("ClankieTranscriptMarkdownBlock", () => {
  it("renders compact Eve-style tool headers with a markdown body", () => {
    const block = new ClankieTranscriptMarkdownBlock("**Tool: bash - completed**\n\n- stdout: ok", theme);
    const rows = block.render(48);
    const compactRows = rows.map((line) => line.trimEnd());
    expect(compactRows[0]).toBe("✓ bash completed");
    expect(rows.some((line) => line.includes("stdout: ok"))).toBe(true);
    expect(rows.every((line) => visibleWidth(line) <= 48)).toBe(true);
  });

  it("rerenders its title and body after setMarkdown", () => {
    const block = new ClankieTranscriptMarkdownBlock("**Tool: bash - completed**\n\n- stdout: ok", theme);
    block.setMarkdown("**Error**\n\nSomething failed.");
    const errorRows = block.render(32);
    expect(errorRows[0]?.trimEnd()).toBe("⨯ Error");
    expect(errorRows.some((line) => line.includes("Something failed."))).toBe(true);
  });

  it("gives untitled markdown a system header", () => {
    const noTitle = new ClankieTranscriptMarkdownBlock("Plain transcript body", theme);
    expect(noTitle.render(32)[0]?.trimEnd()).toBe("Transcript");
  });

  it("renders compact subagent lifecycle headers with a rule gutter body", () => {
    const subagentBlock = new ClankieTranscriptMarkdownBlock(
      "**Subagent: Planner - running**\n\nspawned by codex",
      theme,
    );
    const subagentRows = subagentBlock.render(48).map((line) => line.trimEnd());
    expect(subagentRows[0]).toBe("◆ Planner subagent running");
    expect(subagentRows.some((line) => line.startsWith("│ ") && line.includes("spawned by codex"))).toBe(
      true,
    );
  });

  it("renders distinct skill loading and completed headers", () => {
    const skillBlock = new ClankieTranscriptMarkdownBlock("**Skill: herdr - running**\n\nloading", theme);
    expect(skillBlock.render(48)[0]?.trimEnd()).toBe("✦ herdr loading skill running");
    const skillDoneBlock = new ClankieTranscriptMarkdownBlock(
      "**Skill: herdr - completed**\n\nloaded",
      theme,
    );
    expect(skillDoneBlock.render(48)[0]?.trimEnd()).toBe("✦ herdr skill completed");
    expect(
      new ClankieTranscriptMarkdownBlock("**Skill: herdr-lead - loaded**", theme).render(48)[0]?.trimEnd(),
    ).toBe("✦ herdr-lead skill loaded");
    expect(
      new ClankieTranscriptMarkdownBlock("**Skill: herdr-lead - failed to load**", theme)
        .render(48)[0]
        ?.trimEnd(),
    ).toBe("✦ herdr-lead skill failed to load");
  });

  it("renders nested compact headers for subagent tools", () => {
    const subagentToolBlock = new ClankieTranscriptMarkdownBlock(
      "**Subagent tool: Planner / bash - completed**\n\n-> ok",
      theme,
    );
    expect(subagentToolBlock.render(48)[0]?.trimEnd()).toBe("│ ✓ bash Planner completed");
  });

  it("renders auth, input, approval, running, and failed headers", () => {
    const authBlock = new ClankieTranscriptMarkdownBlock("**Authorization required**\n\nLinear", theme);
    expect(authBlock.render(48)[0]?.trimEnd()).toBe("● Auth required");

    const inputBlock = new ClankieTranscriptMarkdownBlock("**Input requested**\n\nContinue?", theme);
    expect(inputBlock.render(48)[0]?.trimEnd()).toBe("? Input requested");

    const approvalBlock = new ClankieTranscriptMarkdownBlock(
      "**Tool: bash - approved**\n\nanswer: approve",
      theme,
    );
    expect(approvalBlock.render(48)[0]?.trimEnd()).toBe("✓ bash approved");

    const runningToolBlock = new ClankieTranscriptMarkdownBlock(
      "**Tool: bash - running**\n\n$ sleep 1",
      theme,
    );
    expect(runningToolBlock.render(48)[0]?.trimEnd()).toBe("⠃ bash running");

    const subagentFailedBlock = new ClankieTranscriptMarkdownBlock(
      "**Subagent failed: Planner**\n\nboom",
      theme,
    );
    expect(subagentFailedBlock.render(48)[0]?.trimEnd()).toBe("◆ Planner subagent failed");
  });
});

describe("ClankieTranscriptMarkdownBlock render cache", () => {
  it("reuses the same lines across frames but rebuilds after setMarkdown", () => {
    const block = new ClankieTranscriptMarkdownBlock("**Clankie**\n\nfirst", theme);
    const first = block.render(48);
    expect(block.render(48)).toBe(first);

    block.setMarkdown("**Clankie**\n\nsecond");
    const second = block.render(48);
    expect(second).not.toBe(first);
    expect(second.join("\n")).toContain("second");
    expect(second.join("\n")).not.toContain("first");
  });

  it("rebuilds on a width change and after invalidate", () => {
    const block = new ClankieTranscriptMarkdownBlock("**Clankie**\n\nhello", theme);
    const narrow = block.render(24);
    expect(visibleWidth(narrow[0] ?? "")).toBe(24);
    expect(visibleWidth(block.render(48)[0] ?? "")).toBe(48);

    const cached = block.render(48);
    block.invalidate();
    expect(block.render(48)).not.toBe(cached);
  });

  it("keeps re-rendering an in-flight tool header so its spinner still animates", () => {
    let frame = 0;
    const spinning = { ...theme, loadingGlyph: () => ["⠃", "⠉"][frame % 2] ?? "" };
    const running = new ClankieTranscriptMarkdownBlock("**Tool: bash - running**\n\n$ sleep 1", spinning);
    expect(running.render(48)[0]?.trimEnd()).toBe("⠃ bash running");
    frame = 1;
    expect(running.render(48)[0]?.trimEnd()).toBe("⠉ bash running");

    // A settled tool header has no spinner to advance, so it stays cached.
    const done = new ClankieTranscriptMarkdownBlock("**Tool: bash - completed**\n\nok", spinning);
    expect(done.render(48)).toBe(done.render(48));
  });
});
