import { beforeEach, expect, it, vi } from "vitest";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { ClankieFaceShell } from "../src/shell/shell.ts";

let shell: ClankieFaceShell;
/** One real full-screen frame: layout, scroll position and all. */
const screen = () => {
  const tui = shell.tui as unknown as { altScreenActive: boolean; doRender(): void };
  tui.altScreenActive = true; // start() is stubbed; no TTY in tests.
  tui.doRender();
  return shell.tui.getScreenLines().map(stripTerminalSequences).join("\n");
};
const hint = "↑ scroll up for earlier messages";

beforeEach(() => {
  shell = new ClankieFaceShell({
    commands: [],
    cwd: process.cwd(),
    env: {},
    bannerFields: { title: "Clankie" },
  });
  vi.spyOn(shell.tui.terminal, "rows", "get").mockReturnValue(30);
  vi.spyOn(shell.tui.terminal, "columns", "get").mockReturnValue(100);
  vi.spyOn(shell.tui.terminal, "write").mockImplementation(() => {});
  vi.spyOn(shell.tui, "start").mockImplementation(() => {});
  shell.start();
});

it("opens on a blank page with restored history above it and new messages below the hint", () => {
  shell.renderHistory("replace", () => {
    for (let i = 0; i < 12; i++) shell.insertAssistantMarkdown(`Earlier answer ${i}`);
  });
  // The very first frame is already blank: production draws nothing until history arrives.
  const first = screen();
  expect(first).toContain(hint);
  expect(first).not.toContain("Earlier answer");

  shell.insertUserMessage("A new question");
  expect(screen()).toContain(hint);
  expect(screen()).toContain("A new question");
  // The page fills top-down: the message sits right under the hint, blank rows below it.
  const rows = screen().split("\n");
  const at = (text: string) => rows.findIndex((row) => row.includes(text));
  expect(at("A new question") - at(hint)).toBeGreaterThan(0);
  expect(at("A new question") - at(hint)).toBeLessThanOrEqual(3);
  expect(
    rows.slice(at("A new question") + 2, at("A new question") + 10).every((row) => row.trim() === ""),
  ).toBe(true);

  (
    shell as unknown as { transcriptScrollView: { scrollToStart(): void } }
  ).transcriptScrollView.scrollToStart();
  expect(screen()).toContain("Earlier answer 0");

  // Scrollback keeps the divider but drops the blank rows.
  const scrollback = (
    shell as unknown as { renderTranscriptForScrollback(): string }
  ).renderTranscriptForScrollback();
  expect(stripTerminalSequences(scrollback)).toMatch(
    /Earlier answer 11\n+\s*─+ ↑ scroll up for earlier messages ─+\n+\s*.*A new question/u,
  );
});

it("gives only the first restored history a blank page", () => {
  shell.renderHistory("replace", () => {});
  shell.renderHistory("replace", () => shell.insertAssistantMarkdown("Switched conversation"));
  expect(screen()).toContain("Switched conversation");
  expect(screen()).not.toContain(hint);
});

it("keeps the blank page below the transcript when history arrives before the TUI starts", () => {
  const early = new ClankieFaceShell({
    commands: [],
    cwd: process.cwd(),
    env: {},
    bannerFields: { title: "Clankie" },
  });
  vi.spyOn(early.tui.terminal, "rows", "get").mockReturnValue(30);
  vi.spyOn(early.tui.terminal, "columns", "get").mockReturnValue(100);
  vi.spyOn(early.tui.terminal, "write").mockImplementation(() => {});
  vi.spyOn(early.tui, "start").mockImplementation(() => {});
  early.renderHistory("replace", () => early.insertAssistantMarkdown("Restored before start"));
  early.start();
  shell = early;
  expect(screen()).toContain(hint);
  expect(screen()).not.toContain("Restored before start");
});
