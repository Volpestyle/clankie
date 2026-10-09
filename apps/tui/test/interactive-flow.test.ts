import { Editor, visibleWidth, type TUI } from "@earendil-works/pi-tui";
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
  it("submits typed input and requests renders", () => {
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
  it("filters options and submits the highlighted value", () => {
    let singleSelected: string | undefined;
    const singlePrompt = new InteractiveSelectPrompt({
      message: "Choose provider.",
      onCancel: () => {
        singleSelected = undefined;
      },
      onRender: () => undefined,
      onSubmit: (value) => {
        singleSelected = value;
      },
      options: selectOptions,
      theme,
    });
    singlePrompt.focused = true;
    singlePrompt.handleInput("cl");
    singlePrompt.handleInput("\r");
    expect(singleSelected).toBe("claude");
    expectFits(singlePrompt.render(50), 50);
  });

  it("does not repeat the title line in the message body", () => {
    const duplicateTitlePrompt = new InteractiveSelectPrompt({
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
    let rightSelected: string | undefined;
    const rightPrompt = new InteractiveSelectPrompt({
      message: "Choose provider.",
      onCancel: () => undefined,
      onRender: () => undefined,
      onSubmit: (value) => {
        rightSelected = value;
      },
      options: selectOptions,
      theme,
    });
    rightPrompt.handleInput("\x1b[B");
    rightPrompt.handleInput("\x1b[C");
    expect(rightSelected).toBe("claude");
  });

  it("submits the initially highlighted current value", () => {
    let selected: string | undefined;
    const currentPrompt = new InteractiveSelectPrompt({
      currentValue: "local",
      initialValue: "local",
      message: "Place the chat input.",
      onCancel: () => undefined,
      onRender: () => undefined,
      onSubmit: (value) => {
        selected = value;
      },
      options: selectOptions,
      theme,
    });
    currentPrompt.handleInput("\r");
    expect(selected).toBe("local");
  });

  it("triggers back on left arrow only when allowBack is set", () => {
    let backCancelled = false;
    let backSubmitted = false;
    const backPrompt = new InteractiveSelectPrompt({
      allowBack: true,
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
    backPrompt.handleInput("\x1b[D");
    expect(backCancelled).toBe(true);
    expect(backSubmitted).toBe(false);

    let noBackCancelled = false;
    const noBackPrompt = new InteractiveSelectPrompt({
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
    noBackPrompt.handleInput("\x1b[D");
    expect(noBackCancelled).toBe(false);
  });

  it("closes the highlighted option with x when the selector provides that action", () => {
    let closed: string | undefined;
    const prompt = new InteractiveSelectPrompt({
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
    expect(prompt.render(80).some((line) => stripAnsi(line).includes('filter "x"'))).toBe(false);
  });
});
