import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  clankieCommandCompletion,
  createClankieAutocompleteProvider,
  describeClankieCommand,
  resolveClankieCommand,
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
  typeaheadSelectionDelta,
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
    name: "conversation",
    aliases: ["chat"],
    description: "List or select a server-owned operator conversation",
    argumentHint: "[<conversation-id>]",
    takesArgument: true,
  },
  {
    name: "trace",
    aliases: [],
    description: "Watch another lane's activity",
    argumentHint: "[<lane>|all|off]",
    takesArgument: true,
  },
  {
    name: "layout",
    aliases: ["header", "banner"],
    description: "Configure header, chat input, and status bar",
    argumentHint: "[status|input top|input bottom|status above|status below|header on|header off]",
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
    aliases: ["login"],
    description: "Manage API keys, subscription OAuth, and harness logins",
    argumentHint: "[status]",
    takesArgument: true,
  },
  {
    name: "effort",
    aliases: [],
    description: "Set reasoning effort for the active provider",
    takesArgument: false,
  },
  {
    name: "image-model",
    aliases: [],
    description: "Choose the model Clankie makes pictures with",
    argumentHint: "[openai|google|xai|status|unset]",
    takesArgument: true,
  },
  {
    name: "video-model",
    aliases: [],
    description: "Choose the model Clankie makes video with",
    argumentHint: "[xai|status|unset]",
    takesArgument: true,
  },
  {
    name: "connect",
    aliases: ["integrations"],
    description: "Connect Linear, email, and Discord so Clankie can use them",
    argumentHint: "[status|linear|email|discord]",
    takesArgument: true,
  },
  {
    name: "voice",
    aliases: [],
    description: "Configure how Clankie sounds in Discord voice",
    argumentHint: "[status]",
    takesArgument: true,
  },
  {
    name: "discord",
    aliases: [],
    description: "Configure Discord ids, allowlists, and the activity plane",
    argumentHint: "[status|invite]",
    takesArgument: true,
  },
  {
    name: "board",
    aliases: ["herdr-lead", "herd-lead"],
    description: "Open, focus, or close the herdr-lead companion board",
    argumentHint: "[focus|close]",
    takesArgument: true,
  },
];

const provider = createClankieAutocompleteProvider(commands, process.cwd(), {
  listSkills: () => [
    { name: "herdr", description: "Lead coding agents in visible panes" },
    { name: "trace-clankie", description: "Read Clankie's durable trails" },
  ],
});

const signal = new AbortController().signal;

describe("command typeahead", () => {
  it("leaves command-token suggestions to the command typeahead", async () => {
    expect(await provider.getSuggestions(["/mod"], 0, 4, { signal })).toBeNull();
  });

  it("resolves alias queries to the canonical command", () => {
    const aliasState = required(clankieCommandTypeaheadFor(commands, "/integ"), "alias typeahead state");
    const selected = required(selectedClankieCommandTypeahead(aliasState), "alias selection");
    expect(selected.name).toBe("connect");
    expect(clankieCommandCompletion(selected)).toBe("/connect ");
    const aliasRows = renderClankieCommandTypeahead(aliasState, theme, 72);
    expect(aliasRows.some((line) => line.includes("/connect"))).toBe(true);
    expectFits(aliasRows, 72);
  });

  it("collapses exact commands and aliases to inline argument hints", () => {
    const exactTraceState = required(clankieCommandTypeaheadFor(commands, "/trace"), "exact command state");
    expect(inlineClankieCommandHint(exactTraceState)).toBe("[<lane>|all|off]");
    const exactAliasState = required(
      clankieCommandTypeaheadFor(commands, "/integrations"),
      "exact alias state",
    );
    expect(selectedClankieCommandTypeahead(exactAliasState)?.name).toBe("connect");
    expect(inlineClankieCommandHint(exactAliasState)).toBe("[status|linear|email|discord]");
  });

  it("keeps a space between aliases and the description when the invocation column is full", () => {
    const colliding: ClankieAutocompleteCommand[] = [
      {
        name: "auth",
        aliases: ["login", "connect"],
        description: "Manage API keys, subscription OAuth, and harness logins",
        takesArgument: true,
      },
      {
        name: "connect",
        aliases: ["integrations"],
        description: "Connect Linear, email, and Discord so Clankie can use them",
        takesArgument: true,
      },
    ];
    const state = moveClankieCommandTypeaheadSelection(
      required(clankieCommandTypeaheadFor(colliding, "/con"), "prefix typeahead"),
      1,
    );
    const rows = renderClankieCommandTypeahead(state, theme, 48);
    const selected = rows.find((line) => stripAnsi(line).includes("/auth"));
    expect(stripAnsi(selected ?? "")).not.toMatch(/\)[A-Za-z]/u);
    expect(stripAnsi(selected ?? "")).toMatch(/\/auth \(.*\) Manage/u);
  });

  it("prefers /connect over /conversation for the /con prefix", () => {
    const colliding: ClankieAutocompleteCommand[] = [
      {
        name: "conversation",
        aliases: ["chat"],
        description: "List or select a conversation",
        takesArgument: true,
      },
      {
        name: "connect",
        aliases: ["integrations"],
        description: "Connect Linear, email, and Discord",
        argumentHint: "[status|linear|email|discord]",
        takesArgument: true,
      },
    ];
    const state = required(clankieCommandTypeaheadFor(colliding, "/con"), "con prefix");
    expect(state.matches.map((command) => command.name)).toEqual(["connect", "conversation"]);
    expect(selectedClankieCommandTypeahead(state)?.name).toBe("connect");
  });

  it("does not treat a Kitty key-release as another typeahead move", () => {
    expect(typeaheadSelectionDelta("\x1b[B")).toBe(1);
    expect(typeaheadSelectionDelta("\x1b[A")).toBe(-1);
    expect(typeaheadSelectionDelta("\x1b[1;1:3B")).toBeUndefined();
    expect(typeaheadSelectionDelta("\x1b[1;1:3A")).toBeUndefined();
  });

  it("prefers a real /connect command over /auth's leftover connect alias", () => {
    const colliding: ClankieAutocompleteCommand[] = [
      {
        name: "auth",
        aliases: ["login", "connect"],
        description: "Manage API keys",
        argumentHint: "[status]",
        takesArgument: true,
      },
      {
        name: "connect",
        aliases: ["integrations"],
        description: "Connect Linear, email, and Discord",
        argumentHint: "[status|linear|email|discord]",
        takesArgument: true,
      },
    ];

    expect(resolveClankieCommand(colliding, "connect")?.command.name).toBe("connect");
    expect(resolveClankieCommand(colliding, "login")?.command.name).toBe("auth");

    const state = required(clankieCommandTypeaheadFor(colliding, "/connect"), "connect typeahead");
    expect(selectedClankieCommandTypeahead(state)?.name).toBe("connect");
    expect(inlineClankieCommandHint(state)).toBe("[status|linear|email|discord]");
    expect(state.matches.map((command) => command.name)).toEqual(["connect", "auth"]);

    const prefix = required(clankieCommandTypeaheadFor(colliding, "/con"), "connect prefix");
    expect(selectedClankieCommandTypeahead(prefix)?.name).toBe("connect");
    const moved = moveClankieCommandTypeaheadSelection(prefix, 1);
    expect(selectedClankieCommandTypeahead(moved)?.name).toBe("auth");
    expect(selectedClankieCommandTypeahead(clankieCommandTypeaheadFor(colliding, "/con", moved))?.name).toBe(
      "auth",
    );
  });

  it("renders the bare-slash menu with a spacer and description preview", () => {
    const rootState = required(clankieCommandTypeaheadFor(commands, "/"), "root typeahead state");
    const rootRows = renderClankieCommandTypeahead(rootState, theme, 72);
    expect(stripAnsi(rootRows[0] ?? "")).toBe("");
    expect(rootRows.some((line) => line.includes("/conversation"))).toBe(true);

    const narrowRootRows = renderClankieCommandTypeahead(rootState, accentTheme, 64);
    expect(stripAnsi(narrowRootRows[0] ?? "")).toBe("");
    expect(stripAnsi(narrowRootRows[1] ?? "")).toBe("List or select a server-owned operator conversation");
    expect(narrowRootRows[1]?.startsWith("\x1b[33m")).toBe(true);
    expectFits(narrowRootRows, 64);

    const wideRootRows = renderClankieCommandTypeahead(rootState, theme, 140);
    expect(
      wideRootRows[1]?.includes("/conversation"),
      "skips the preview when the row description fits",
    ).toBe(true);
    const selectedDescriptionRows = renderClankieCommandTypeahead(rootState, selectedDescriptionTheme, 140);
    expect(selectedDescriptionRows[1]?.includes("\x1b[37mList or select")).toBe(true);
  });

  it("respects the row budget, wraps selection, and tracks dismissal", () => {
    const rootState = required(clankieCommandTypeaheadFor(commands, "/"), "root typeahead state");
    expect(renderClankieCommandTypeahead(rootState, theme, 72, 2).length).toBe(2);
    expect(renderClankieCommandTypeahead(rootState, theme, 72, 0).length).toBe(0);
    const wrappedState = moveClankieCommandTypeaheadSelection(rootState, -1);
    expect(selectedClankieCommandTypeahead(wrappedState)?.name).toBe("board");
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

  it("completes model and auth arguments", async () => {
    expect((await items("/provider sm", 12)).some((item) => item.value === "small")).toBe(true);
    expect((await items("/model sm", 9)).some((item) => item.value === "small")).toBe(true);
    expect((await items("/model st", 9)).some((item) => item.value === "status")).toBe(true);
    expect((await items("/auth st", 8)).some((item) => item.value === "status")).toBe(true);
    expect((await items("/auth xa", 8)).some((item) => item.value === "xai")).toBe(true);
  });

  it("completes image-model, voice, and Discord arguments", async () => {
    expect((await items("/image-model st", 15)).some((item) => item.value === "status")).toBe(true);
    expect((await items("/voice st", 9)).some((item) => item.value === "status")).toBe(true);
    expect((await items("/discord in", 11)).some((item) => item.value === "invite")).toBe(true);
  });

  it("completes layout arguments", async () => {
    expect((await items("/layout in", 10)).some((item) => item.value === "input")).toBe(true);
    expect((await items("/layout input t", 15)).some((item) => item.value === "top")).toBe(true);
    expect((await items("/layout status b", 16)).some((item) => item.value === "below")).toBe(true);
  });

  it("completes /connect catalog arguments", async () => {
    expect((await items("/connect li", 11)).some((item) => item.value === "linear")).toBe(true);
    expect((await items("/connect em", 11)).some((item) => item.value === "email")).toBe(true);
    expect((await items("/connect d", 10)).some((item) => item.value === "discord")).toBe(true);
  });
});

describe("skill suggestions", () => {
  it("completes a $ skill mention at a token boundary", async () => {
    expect(provider.triggerCharacters).toEqual(["$"]);
    const suggestions = required(
      await provider.getSuggestions(["Use $her"], 0, 8, { signal }),
      "skill suggestions",
    );
    expect(suggestions.prefix).toBe("$her");
    expect(suggestions.items[0]).toMatchObject({
      value: "herdr",
      label: "$herdr",
      description: "Lead coding agents in visible panes",
    });
    expect(
      provider.applyCompletion(["Use $her"], 0, 8, suggestions.items[0]!, suggestions.prefix),
    ).toMatchObject({ lines: ["Use $herdr "], cursorLine: 0, cursorCol: 11 });
  });

  it("does not treat a dollar sign inside a token as a skill mention", async () => {
    expect(await provider.getSuggestions(["price$her"], 0, 9, { signal })).toBeNull();
  });
});

describe("command search and detail", () => {
  it("matches command descriptions and exposes valid args plus examples", () => {
    const commandSearch = searchClankieCommands(commands, "lane");
    expect(commandSearch[0]?.command.name).toBe("trace");
    const traceCommand = required(
      commands.find((command) => command.name === "trace"),
      "trace command",
    );
    const traceDetail = describeClankieCommand(traceCommand);
    expect(traceDetail.validArgs.some((item) => item.value === "all")).toBe(true);
    expect(traceDetail.examples.includes("/trace all")).toBe(true);
  });
});

describe("typeahead panel", () => {
  it("shows argument details after command whitespace and hides while overlays own keys", () => {
    const rootState = required(clankieCommandTypeaheadFor(commands, "/"), "root typeahead state");
    const panel = new ClankieCommandTypeaheadPanel(commands, theme);
    panel.setText("/trace ", undefined);
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
    shortPanel.setText("/trace ", undefined);
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
      "integ",
    );
    expect(workbench.getFilter()).toBe("integ");
    expect(workbench.getSelectedCommand()?.name).toBe("connect");
    expectFits(workbench.render(88), 88);
    expectFits(workbench.render(48), 48);
    expect(workbench.render(88)[0]?.startsWith("┌")).toBe(true);
    workbench.handleInput("\r");
    expect(submitted).toBe("/connect ");
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
      "trace",
    );
    exampleWorkbench.handleInput("\t");
    expect(submitted).toBe("/trace discord_presence");
  });
});
