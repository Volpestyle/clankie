import { CURSOR_MARKER, Editor, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  InteractiveSelectPrompt,
  InteractiveTextPrompt,
  type InteractivePromptOption,
} from "../src/face/clankie-interactive-flow.ts";

const theme = {
  description: (text: string) => text,
  noMatch: (text: string) => text,
  scrollInfo: (text: string) => text,
  selectedPrefix: (text: string) => text,
  selectedText: (text: string) => text,
};

function expectFits(lines: readonly string[], width: number): void {
  for (const line of lines) {
    expect(visibleWidth(line), `line should fit width ${width}: ${JSON.stringify(line)}`).toBeLessThanOrEqual(
      width,
    );
  }
}

function stripAnsi(text: string): string {
  // oxlint-disable-next-line no-control-regex -- intentionally strips ANSI escape sequences
  return text.replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/gu, "");
}

const selectOptions: InteractivePromptOption[] = [
  { value: "codex", label: "codex", description: "OpenAI subscription" },
  { value: "claude", label: "claude", description: "Anthropic subscription" },
  { value: "local", label: "local", description: "OpenAI-compatible local endpoint" },
];

describe("InteractiveTextPrompt", () => {
  it("submits typed input, requests renders, and renders a solid outline", () => {
    let textSubmitted: string | undefined;
    let textCancelled = false;
    let renderCount = 0;
    const textPrompt = new InteractiveTextPrompt({
      message: "Enter the local model id.",
      onCancel: () => {
        textCancelled = true;
      },
      onRender: () => {
        renderCount += 1;
      },
      onSubmit: (value) => {
        textSubmitted = value;
      },
      placeholder: "qwen3-coder",
    });
    textPrompt.focused = true;
    textPrompt.handleInput("qwen");
    textPrompt.handleInput("\n");
    expect(textSubmitted).toBe("qwen");
    expect(textCancelled).toBe(false);
    expect(renderCount).toBeGreaterThan(0);
    expectFits(textPrompt.render(44), 44);
    expect(stripAnsi(textPrompt.render(44)[0] ?? "").startsWith("┌")).toBe(true);
  });

  it("renders a back hint when allowBack is set", () => {
    const backTextPrompt = new InteractiveTextPrompt({
      allowBack: true,
      message: "Set the realtime voice.",
      onCancel: () => undefined,
      onRender: () => undefined,
      onSubmit: () => undefined,
    });
    expect(backTextPrompt.render(60).some((line) => stripAnsi(line).includes("Esc goes back"))).toBe(true);
  });

  it("renders an existing multi-line value in the editor", () => {
    const editor = new Editor({ terminal: { rows: 40 } } as unknown as TUI, {
      borderColor: (text) => text,
      selectList: theme,
    });
    const textPrompt = new InteractiveTextPrompt({
      defaultValue: "First paragraph.\n\nSecond paragraph.",
      editor,
      message: "Character",
      onCancel: () => undefined,
      onRender: () => undefined,
      onSubmit: () => undefined,
    });

    const rendered = textPrompt.render(60).map(stripAnsi).join("\n");
    expect(rendered).toContain("First paragraph.");
    expect(rendered).toContain("Second paragraph.");
    expect(rendered).toContain("Shift+Enter adds a line");
  });

  it("masks sensitive values at every supported width", () => {
    const secret = "sk-test-never-render-this";
    const secretPrompt = new InteractiveTextPrompt({
      message: "API key",
      onCancel: () => undefined,
      onRender: () => undefined,
      onSubmit: () => undefined,
      placeholder: secret,
      sensitive: true,
    });
    secretPrompt.focused = true;
    secretPrompt.handleInput(secret);

    for (const width of [12, 24, 44, 80]) {
      const rendered = secretPrompt.render(width);
      expect(rendered.join("\n")).not.toContain(secret);
      expect(rendered.join("\n")).not.toContain("Placeholder:");
      expectFits(rendered, width);
    }
  });
});

describe("InteractiveSelectPrompt single select", () => {
  it("filters options, derives a title, and submits the highlighted value", () => {
    let singleSelected: readonly string[] | undefined;
    const singlePrompt = new InteractiveSelectPrompt({
      kind: "single",
      message: "Choose provider.",
      onCancel: () => {
        singleSelected = undefined;
      },
      onRender: () => undefined,
      onSubmit: (values) => {
        singleSelected = values;
      },
      options: selectOptions,
      required: true,
      theme,
    });
    singlePrompt.focused = true;
    singlePrompt.handleInput("cl");
    const filteredSingleRows = singlePrompt.render(60);
    expect(stripAnsi(filteredSingleRows[0] ?? "").startsWith("┌")).toBe(true);
    expect(filteredSingleRows.some((line) => line.includes("Provider"))).toBe(true);
    expect(filteredSingleRows.some((line) => line.includes("claude"))).toBe(true);
    expect(
      filteredSingleRows.some((line) => line.includes('filter "cl"') && line.includes("Showing 1 of 3")),
    ).toBe(true);
    expect(filteredSingleRows.some((line) => line.includes(CURSOR_MARKER))).toBe(true);
    expect(filteredSingleRows.some((line) => line.includes("Anthropic subscription"))).toBe(true);
    singlePrompt.handleInput("\r");
    expect(singleSelected?.[0]).toBe("claude");
    expectFits(singlePrompt.render(50), 50);
  });

  it("does not repeat the title line in the message body", () => {
    const duplicateTitlePrompt = new InteractiveSelectPrompt({
      kind: "single",
      message: "What exactly do you want?\n\n- select request call_123\n  What exactly do you want?",
      onCancel: () => undefined,
      onRender: () => undefined,
      onSubmit: () => undefined,
      options: selectOptions,
      theme,
    });
    const duplicateTitleRows = duplicateTitlePrompt.render(80).map(stripAnsi);
    expect(duplicateTitleRows.filter((line) => line.includes("What exactly do you want")).length).toBe(1);
  });

  it("chooses the highlighted option with the right arrow", () => {
    let rightSelected: readonly string[] | undefined;
    const rightPrompt = new InteractiveSelectPrompt({
      kind: "single",
      message: "Choose provider.",
      onCancel: () => undefined,
      onRender: () => undefined,
      onSubmit: (values) => {
        rightSelected = values;
      },
      options: selectOptions,
      theme,
    });
    rightPrompt.handleInput("\x1b[B");
    rightPrompt.handleInput("\x1b[C");
    expect(rightSelected?.[0]).toBe("claude");
    expect(rightPrompt.render(60).some((line) => stripAnsi(line).includes("Enter/→ chooses"))).toBe(true);
  });

  it("marks and hovers the current value", () => {
    const currentPrompt = new InteractiveSelectPrompt({
      currentValue: "local",
      initialValue: "local",
      kind: "single",
      message: "Place the chat input.",
      onCancel: () => undefined,
      onRender: () => undefined,
      onSubmit: () => undefined,
      options: selectOptions,
      theme,
    });
    const currentRows = currentPrompt.render(72).map(stripAnsi);
    expect(currentRows.some((line) => line.includes("local (current)"))).toBe(true);
    expect(currentRows.some((line) => line.includes("> local (current)"))).toBe(true);
  });

  it("renders status actions tightly under the status summary, outside the option list", () => {
    const labeledActionPrompt = new InteractiveSelectPrompt({
      initialValue: "details",
      kind: "single",
      message: "Current status\n\nChoose a setting.",
      onCancel: () => undefined,
      onRender: () => undefined,
      onSubmit: () => undefined,
      options: [{ value: "setting", label: "setting", description: "normal row" }],
      statusActions: [{ value: "details", label: "▶", description: "show details" }],
      theme: {
        ...theme,
        selectedPrefix: (text) => `\x1b[36m${text}\x1b[39m`,
        selectedText: (text) => `\x1b[1m${text}\x1b[22m`,
      },
    });
    const rawLabeledActionRows = labeledActionPrompt.render(72);
    const labeledActionRows = rawLabeledActionRows.map(stripAnsi);
    const normalDetailRowIndex = labeledActionRows.findIndex((line) => line.includes("normal row"));
    const statusSummaryRowIndex = labeledActionRows.findIndex((line) => line.includes("Current status"));
    const promptRowIndex = labeledActionRows.findIndex((line) => line.includes("Choose a setting."));
    const statusToggleRowIndex = labeledActionRows.findIndex((line) => line.includes("show details"));
    const normalDetailRow = labeledActionRows[normalDetailRowIndex];
    const statusSummaryRow = labeledActionRows[statusSummaryRowIndex];
    const rawStatusToggleRow = rawLabeledActionRows[statusToggleRowIndex];
    const statusToggleRow = labeledActionRows[statusToggleRowIndex];
    if (normalDetailRow === undefined || statusSummaryRow === undefined || statusToggleRow === undefined) {
      throw new Error("description action fixture should render detail, summary, and action rows");
    }
    expect(statusSummaryRowIndex).toBeGreaterThanOrEqual(0);
    expect(statusToggleRowIndex).toBe(statusSummaryRowIndex + 1);
    expect(statusToggleRowIndex).toBeLessThan(promptRowIndex);
    expect(promptRowIndex).toBeLessThan(normalDetailRowIndex);
    expect(statusToggleRow.includes(">")).toBe(false);
    expect(statusToggleRow.indexOf("▶")).toBe(statusSummaryRow.indexOf("Current status"));
    expect(rawStatusToggleRow?.includes("\x1b[36m")).toBe(true);
    expect(statusToggleRow.indexOf("▶")).toBeLessThan(statusToggleRow.indexOf("show details"));
    expect(statusToggleRow.indexOf("show details")).toBe(normalDetailRow.indexOf("normal row"));
  });

  it("triggers back on left arrow only when allowBack is set", () => {
    let backCancelled = false;
    let backSubmitted = false;
    const backPrompt = new InteractiveSelectPrompt({
      allowBack: true,
      kind: "single",
      message: "Choose provider.",
      onCancel: () => {
        backCancelled = true;
      },
      onRender: () => undefined,
      onSubmit: () => {
        backSubmitted = true;
      },
      options: selectOptions,
      theme,
    });
    backPrompt.focused = true;
    expect(backPrompt.render(100).some((line) => stripAnsi(line).includes("← Back"))).toBe(true);
    backPrompt.handleInput("\x1b[D");
    expect(backCancelled).toBe(true);
    expect(backSubmitted).toBe(false);

    let noBackCancelled = false;
    const noBackPrompt = new InteractiveSelectPrompt({
      kind: "single",
      message: "Choose provider.",
      onCancel: () => {
        noBackCancelled = true;
      },
      onRender: () => undefined,
      onSubmit: () => undefined,
      options: selectOptions,
      theme,
    });
    noBackPrompt.focused = true;
    expect(noBackPrompt.render(100).some((line) => stripAnsi(line).includes("Esc cancels"))).toBe(true);
    noBackPrompt.handleInput("\x1b[D");
    expect(noBackCancelled).toBe(false);
    noBackPrompt.handleInput("x");
    expect(noBackPrompt.render(100).some((line) => stripAnsi(line).includes('filter "x"'))).toBe(true);
  });

  it("closes the highlighted option with x when the selector provides that action", () => {
    let closed: string | undefined;
    const prompt = new InteractiveSelectPrompt({
      kind: "single",
      message: "Conversations",
      onCancel: () => undefined,
      onClose: (value) => {
        closed = value;
      },
      onRender: () => undefined,
      onSubmit: () => undefined,
      options: selectOptions,
      theme,
    });

    prompt.handleInput("x");

    expect(closed).toBe("codex");
    expect(prompt.render(80).some((line) => stripAnsi(line).includes("x closes selected"))).toBe(true);
    expect(prompt.render(80).some((line) => stripAnsi(line).includes('filter "x"'))).toBe(false);
  });
});
