import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  clankieCommandCompletion,
  createClankieAutocompleteProvider,
  describeClankieCommand,
  formatClankieCommandInspector,
  searchClankieCommands,
  type ClankieAutocompleteCommand,
} from "../src/face/clankie-autocomplete.ts";
import {
  ClankieCommandTypeaheadPanel,
  ClankieCommandWorkbench,
  clankieCommandTypeaheadFor,
  dismissClankieCommandTypeahead,
  inlineClankieCommandHint,
  moveClankieCommandTypeaheadSelection,
  renderClankieCommandTypeahead,
  selectedClankieCommandTypeahead,
} from "../src/face/clankie-command-ui.ts";

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

function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`${label} should be present`);
  return value;
}

const theme = {
  bold: (text: string) => text,
  cyan: (text: string) => text,
  dim: (text: string) => text,
  green: (text: string) => text,
  red: (text: string) => text,
  yellow: (text: string) => text,
};

const accentTheme = {
  ...theme,
  yellow: (text: string) => `\x1b[33m${text}\x1b[39m`,
};
const selectedDescriptionTheme = {
  ...theme,
  selectedDescription: (text: string) => `\x1b[37m${text}\x1b[39m`,
};

const commands: ClankieAutocompleteCommand[] = [
  {
    name: "n",
    aliases: [],
    description: "Start a fresh session and clear the transcript",
    takesArgument: false,
  },
  {
    name: "new",
    aliases: [],
    description: "Start a fresh session and clear the transcript",
    takesArgument: false,
  },
  {
    name: "discord-token",
    aliases: ["token"],
    description: "Set the Discord credential and restart Clankie",
    argumentHint: "[status|<token>] [--user-token] [--voice]",
    takesArgument: true,
  },
  {
    name: "provider",
    aliases: [],
    description: "Choose which provider the model picker browses",
    argumentHint: "[small|voice|status]",
    takesArgument: true,
  },
  {
    name: "model",
    aliases: [],
    description: "Choose a model from the selected provider",
    argumentHint: "[small|voice|status]",
    takesArgument: true,
  },
  {
    name: "auth",
    aliases: ["credentials", "creds", "keys"],
    description: "Manage subscription logins, API keys, and service credentials",
    argumentHint: "[status|codex|claude|xai|gemini|openai|discord|mcp|elevenlabs|relay|local-voice]",
    takesArgument: true,
  },
  {
    name: "effort",
    aliases: [],
    description: "Set reasoning effort for the active provider",
    argumentHint: "[status|minimal|low|medium|high|xhigh|unset]",
    takesArgument: true,
  },
  {
    name: "image-model",
    aliases: ["images"],
    description: "Set OpenAI image generation model",
    argumentHint: "[model-id|status|unset]",
    takesArgument: true,
  },
  {
    name: "profile",
    aliases: [],
    description: "Switch between an all-local stack and hosted API providers",
    argumentHint: "[status|local-tiered|local-single|api|local-api|api-local] [model]",
    takesArgument: true,
  },
  {
    name: "policies",
    aliases: ["policy"],
    description: "Configure behavior policy flags",
    argumentHint: "[status|direct|autonomous|approval|pr-only|merge-authority|design-gate|pr-granularity]",
    takesArgument: true,
  },
  {
    name: "voice",
    aliases: [],
    description: "Configure Discord voice runtime",
    argumentHint: "[status|mode|model|realtime-voice|tts|elevenlabs|memory|eve-session] [value]",
    takesArgument: true,
  },
  {
    name: "setup",
    aliases: [],
    description: "Bootstrap broker credentials and choose first setup steps",
    argumentHint: "[status|bootstrap|model|auth|integrations]",
    takesArgument: true,
  },
  {
    name: "integrations",
    aliases: [],
    description: "Bind integration roles and PR / Version Control settings",
    argumentHint: "[status|role|pr-line-limit] [connection|none|unset|lines]",
    takesArgument: true,
  },
  {
    name: "mcp",
    aliases: [],
    description: "Manage dynamic MCPs and curated MCP connection auth",
    argumentHint: "[status|list|add|remove|enable|disable|auth|install]",
    takesArgument: true,
  },
  {
    name: "browser",
    aliases: ["bridge"],
    description: "Install or inspect the browser-control extension bridge",
    argumentHint: "[status|install]",
    takesArgument: true,
  },
  {
    name: "spawn",
    aliases: [],
    description: "Spawn a herdr worker pane through the transcript seam",
    argumentHint: "--harness <clankie|claude|codex|opencode|custom> [--cwd path] <slug> <task>",
    takesArgument: true,
  },
  {
    name: "skills",
    aliases: ["skill"],
    description: "Show Clankie's skills",
    takesArgument: false,
  },
  {
    name: "trace",
    aliases: [],
    description: "Show compact per-turn stream traces",
    argumentHint: "[status|off|no-reply|all]",
    takesArgument: true,
  },
  {
    name: "layout",
    aliases: ["header", "banner"],
    description: "Configure header, chat input, and status bar placement",
    argumentHint: "[status|input top|input bottom|status above|status below|header on|header off]",
    takesArgument: true,
  },
];

const provider = createClankieAutocompleteProvider(commands, process.cwd(), {
  listMcpConnectionNames: () => ["linear", "figma"],
  listMcpServerNames: () => ["local-tools", "browser-tools"],
});

const signal = new AbortController().signal;

describe("command typeahead", () => {
  it("leaves command-token suggestions to the command typeahead", async () => {
    expect(await provider.getSuggestions(["/tok"], 0, 4, { signal })).toBeNull();
  });

  it("resolves alias queries to the canonical command", () => {
    const aliasState = required(clankieCommandTypeaheadFor(commands, "/tok"), "alias typeahead state");
    const selected = required(selectedClankieCommandTypeahead(aliasState), "alias selection");
    expect(selected.name).toBe("discord-token");
    expect(clankieCommandCompletion(selected)).toBe("/discord-token ");
    const aliasRows = renderClankieCommandTypeahead(aliasState, theme, 72);
    expect(aliasRows.some((line) => line.includes("/discord-token"))).toBe(true);
    expectFits(aliasRows, 72);
  });

  it("collapses exact commands and aliases to inline argument hints", () => {
    const exactMcpState = required(clankieCommandTypeaheadFor(commands, "/mcp"), "exact command state");
    expect(inlineClankieCommandHint(exactMcpState)).toBe(
      "[status|list|add|remove|enable|disable|auth|install]",
    );
    const exactAliasState = required(clankieCommandTypeaheadFor(commands, "/token"), "exact alias state");
    expect(selectedClankieCommandTypeahead(exactAliasState)?.name).toBe("discord-token");
    expect(inlineClankieCommandHint(exactAliasState)).toBe("[status|<token>] [--user-token] [--voice]");
  });

  it("keeps /n as its own command", () => {
    const shortNewState = required(clankieCommandTypeaheadFor(commands, "/n"), "new shortcut state");
    const selected = required(selectedClankieCommandTypeahead(shortNewState), "new shortcut selection");
    expect(selected.name).toBe("n");
    expect(clankieCommandCompletion(selected)).toBe("/n");
  });

  it("renders the bare-slash menu with a spacer and description preview", () => {
    const rootState = required(clankieCommandTypeaheadFor(commands, "/"), "root typeahead state");
    const rootRows = renderClankieCommandTypeahead(rootState, theme, 72);
    expect(stripAnsi(rootRows[0] ?? "")).toBe("");
    expect(rootRows.some((line) => line.includes("/n"))).toBe(true);
    expect(rootRows.some((line) => line.includes("/new"))).toBe(true);
    expect(rootRows.every((line) => !line.includes("/new (/n)"))).toBe(true);

    const narrowRootRows = renderClankieCommandTypeahead(rootState, accentTheme, 64);
    expect(stripAnsi(narrowRootRows[0] ?? "")).toBe("");
    expect(stripAnsi(narrowRootRows[1] ?? "")).toBe("Start a fresh session and clear the transcript");
    expect(narrowRootRows[1]?.startsWith("\x1b[33m")).toBe(true);
    expectFits(narrowRootRows, 64);

    const wideRootRows = renderClankieCommandTypeahead(rootState, theme, 140);
    expect(wideRootRows[1]?.includes("/n"), "skips the preview when the row description fits").toBe(true);
    const selectedDescriptionRows = renderClankieCommandTypeahead(rootState, selectedDescriptionTheme, 140);
    expect(selectedDescriptionRows[1]?.includes("\x1b[37mStart a fresh session")).toBe(true);
  });

  it("respects the row budget, wraps selection, and tracks dismissal", () => {
    const rootState = required(clankieCommandTypeaheadFor(commands, "/"), "root typeahead state");
    expect(renderClankieCommandTypeahead(rootState, theme, 72, 2).length).toBe(2);
    expect(renderClankieCommandTypeahead(rootState, theme, 72, 0).length).toBe(0);
    const wrappedState = moveClankieCommandTypeaheadSelection(rootState, -1);
    expect(selectedClankieCommandTypeahead(wrappedState)?.name).toBe("layout");
    const dismissedState = dismissClankieCommandTypeahead(rootState);
    expect(clankieCommandTypeaheadFor(commands, "/", dismissedState)?.dismissed).toBe(true);
    expect(clankieCommandTypeaheadFor(commands, "/m", dismissedState)?.dismissed).toBe(false);
    expect(clankieCommandTypeaheadFor(commands, "", rootState)).toBeUndefined();
  });
});

describe("argument suggestions", () => {
  async function items(line: string, column: number) {
    const suggestions = required(
      await provider.getSuggestions([line], 0, column, { signal }),
      `suggestions for ${line}`,
    );
    return suggestions.items;
  }

  it("completes model, auth, and effort arguments", async () => {
    expect((await items("/provider sm", 12)).some((item) => item.value === "small")).toBe(true);
    expect((await items("/model sm", 9)).some((item) => item.value === "small")).toBe(true);
    expect((await items("/model st", 9)).some((item) => item.value === "status")).toBe(true);
    expect((await items("/auth st", 8)).some((item) => item.value === "status")).toBe(true);
    expect((await items("/auth xa", 8)).some((item) => item.value === "xai")).toBe(true);
    expect((await items("/auth mcp li", 12)).some((item) => item.value === "linear")).toBe(true);
    expect((await items("/effort st", 10)).some((item) => item.value === "status")).toBe(true);
  });

  it("completes discord-token, image-model, and voice arguments", async () => {
    expect((await items("/discord-token st", 17)).some((item) => item.value === "status")).toBe(true);
    expect((await items("/image-model st", 15)).some((item) => item.value === "status")).toBe(true);
    expect((await items("/voice st", 9)).some((item) => item.value === "status")).toBe(true);
    expect((await items("/voice mo", 9)).some((item) => item.value === "mode")).toBe(true);
    expect((await items("/voice mode l", 14)).some((item) => item.value === "local")).toBe(true);
  });

  it("completes profile, policies, and layout arguments", async () => {
    expect((await items("/profile local-t", 16)).some((item) => item.value === "local-tiered")).toBe(true);
    expect((await items("/profile api-l", 14)).some((item) => item.value === "api-local")).toBe(true);
    expect((await items("/policies merge-a", 17)).some((item) => item.value === "merge-authority")).toBe(
      true,
    );
    expect((await items("/layout in", 10)).some((item) => item.value === "input")).toBe(true);
    expect((await items("/layout input t", 15)).some((item) => item.value === "top")).toBe(true);
    expect((await items("/layout status b", 16)).some((item) => item.value === "below")).toBe(true);
  });

  it("completes integrations, browser, and spawn arguments", async () => {
    expect((await items("/integrations st", 16)).some((item) => item.value === "status")).toBe(true);
    expect((await items("/integrations ver", 17)).some((item) => item.value === "version-control")).toBe(
      true,
    );
    expect(
      (await items("/integrations version-control pr", 32)).some((item) => item.value === "pr-line-limit"),
    ).toBe(true);
    expect((await items("/integrations work-tracker n", 28)).some((item) => item.value === "none")).toBe(
      true,
    );
    expect((await items("/browser in", 11)).some((item) => item.value === "install")).toBe(true);
    expect((await items("/spawn --harness c", 18)).some((item) => item.value === "codex")).toBe(true);
  });

  it("completes mcp actions and dynamic connection/server names", async () => {
    expect((await items("/mcp a", 6)).some((item) => item.value === "auth")).toBe(true);

    const mcpConnectionSuggestions = required(
      await provider.getSuggestions(["/mcp auth li"], 0, 12, { signal }),
      "mcp auth suggestions",
    );
    expect(mcpConnectionSuggestions.items.some((item) => item.value === "linear")).toBe(true);
    const mcpConnectionCompletion = provider.applyCompletion(
      ["/mcp auth li"],
      0,
      12,
      { value: "linear", label: "linear" },
      mcpConnectionSuggestions.prefix,
    );
    expect(mcpConnectionCompletion.lines[0], "dynamic completion replaces the current token").toBe(
      "/mcp auth linear ",
    );

    expect((await items("/mcp remove loc", 15)).some((item) => item.value === "local-tools")).toBe(true);
  });
});

describe("command search and detail", () => {
  it("matches command descriptions and exposes valid args plus examples", () => {
    const commandSearch = searchClankieCommands(commands, "dynamic");
    expect(commandSearch[0]?.command.name).toBe("mcp");
    const mcpCommand = required(
      commands.find((command) => command.name === "mcp"),
      "mcp command",
    );
    const mcpDetail = describeClankieCommand(mcpCommand);
    expect(mcpDetail.validArgs.some((item) => item.value === "auth")).toBe(true);
    expect(mcpDetail.examples.includes("/mcp status")).toBe(true);
  });
});

describe("typeahead panel", () => {
  it("shows argument details after command whitespace and hides while overlays own keys", () => {
    const rootState = required(clankieCommandTypeaheadFor(commands, "/"), "root typeahead state");
    const panel = new ClankieCommandTypeaheadPanel(commands, theme);
    panel.setText("/mcp ", undefined);
    const panelRows = panel.render(76);
    expect(panelRows.some((line) => line.includes("next"))).toBe(true);
    expectFits(panelRows, 76);
    panel.setText("/", rootState, true);
    expect(panel.render(76).length).toBe(0);
  });

  it("caps list and detail height from the layout budget", () => {
    const rootState = required(clankieCommandTypeaheadFor(commands, "/"), "root typeahead state");
    const shortPanel = new ClankieCommandTypeaheadPanel(commands, theme, { maxVisibleRows: () => 2 });
    shortPanel.setText("/", rootState);
    expect(shortPanel.render(76).length).toBe(2);
    shortPanel.setText("/mcp ", undefined);
    expect(shortPanel.render(76).length).toBeLessThanOrEqual(2);
    const hiddenPanel = new ClankieCommandTypeaheadPanel(commands, theme, { maxVisibleRows: () => 0 });
    hiddenPanel.setText("/", rootState);
    expect(hiddenPanel.render(76).length).toBe(0);
  });
});

describe("command workbench", () => {
  it("searches aliases, submits the canonical skeleton, and cancels on escape", () => {
    let submitted = "";
    let cancelled = false;
    const workbench = new ClankieCommandWorkbench(
      commands,
      {
        onCancel: () => {
          cancelled = true;
        },
        onRender: () => undefined,
        onSubmit: (text) => {
          submitted = text;
        },
      },
      theme,
      "tok",
    );
    expect(workbench.getFilter()).toBe("tok");
    expect(workbench.getSelectedCommand()?.name).toBe("discord-token");
    expectFits(workbench.render(88), 88);
    expectFits(workbench.render(48), 48);
    expect(workbench.render(88)[0]?.startsWith("┌")).toBe(true);
    workbench.handleInput("\r");
    expect(submitted).toBe("/discord-token ");
    workbench.handleInput("\x1b");
    expect(cancelled).toBe(true);
  });

  it("inserts the first example on tab when available", () => {
    let submitted = "";
    const exampleWorkbench = new ClankieCommandWorkbench(
      commands,
      {
        onCancel: () => undefined,
        onRender: () => undefined,
        onSubmit: (text) => {
          submitted = text;
        },
      },
      theme,
      "mcp",
    );
    exampleWorkbench.handleInput("\t");
    expect(submitted).toBe("/mcp status");
  });
});

describe("command inspector", () => {
  it("identifies the active command with valid args and examples, without spurious warnings", () => {
    const inspector = formatClankieCommandInspector("/mcp a", commands);
    expect(inspector).toContain("**/mcp");
    expect(inspector).toContain("Valid next args:");
    expect(inspector).toContain("/mcp auth linear");
    expect(inspector).not.toContain("Warning: unknown first arg");
    const spawnInspector = formatClankieCommandInspector("/spawn --harness codex docs-review", commands);
    expect(spawnInspector).not.toContain("Warning: unknown first arg");
  });
});
