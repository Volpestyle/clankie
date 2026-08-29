/**
 * Constructs the face shell without starting it (start() needs a TTY) and
 * asserts the basic wiring: setup flow idle, default layout, and the console
 * command set feeding the typeahead/workbench.
 */
import { describe, expect, it, vi } from "vitest";
import { buildConsoleCommands } from "../src/commands.ts";
import { ClankieFaceShell, clickedTranscriptBlock } from "../src/shell/shell.ts";

describe("shell assembly", () => {
  it("wires the face shell without starting it", () => {
    const commands = buildConsoleCommands({});
    const shell = new ClankieFaceShell({
      commands,
      cwd: process.cwd(),
      env: {},
      bannerFields: { title: "Clankie" },
    });
    expect(shell.setupFlow.isWaitingForInput()).toBe(false);
    expect(shell.headerVisible).toBe(true);
  });

  it("renders conversation content through pi's chat components", () => {
    const shell = new ClankieFaceShell({
      commands: buildConsoleCommands({}),
      cwd: process.cwd(),
      env: {},
      bannerFields: { title: "Clankie" },
    });
    shell.insertUserMessage("hello there");
    shell.insertAssistantMarkdown("a **bold** reply");
    shell.insertReasoning("thinking out loud");
    shell.beginToolCall("call-1", "get_self_state", '{"includePresence":true}');
    shell.completeToolCall("call-1", "get_self_state", { failed: false, detail: "status: idle" });
    shell.insertMarkdown("**Notice**\n\na markdown notice");

    const chat = (shell as unknown as { chat: { render(width: number): string[] } }).chat;
    // oxlint-disable-next-line no-control-regex -- intentionally strips ANSI escape sequences
    const ansiPattern = /\x1b\[[0-9;]*m/gu;
    const text = chat.render(80).join("\n").replace(ansiPattern, "");
    expect(text).toContain("hello there");
    expect(text).toContain("bold");
    expect(text).toContain("thinking out loud");
    expect(text).toContain("get_self_state");
    expect(text).toContain("a markdown notice");
  });

  it("maps a transcript click row to the block under it", () => {
    const block = (rows: number) => ({
      invalidate(): void {},
      render: () => Array.from({ length: rows }, () => "x"),
    });
    const first = block(3);
    const second = block(2);
    const third = block(5);
    const blocks = [first, second, third];
    expect(clickedTranscriptBlock(blocks, 80, 0)).toBe(first);
    expect(clickedTranscriptBlock(blocks, 80, 2)).toBe(first);
    expect(clickedTranscriptBlock(blocks, 80, 3)).toBe(second);
    expect(clickedTranscriptBlock(blocks, 80, 4)).toBe(second);
    expect(clickedTranscriptBlock(blocks, 80, 9)).toBe(third);
    expect(clickedTranscriptBlock(blocks, 80, 10)).toBeUndefined();
  });

  it("opens a readable conversation picker", async () => {
    const results: Array<{ invocation: string; text: string }> = [];
    const selected: string[] = [];
    let menu: Parameters<ClankieFaceShell["setupFlow"]["readSelect"]>[0] | undefined;
    const command = buildConsoleCommands({
      conversations: {
        conversationId: "conv-dev",
        title: "dev",
        conversations: async () => [
          {
            conversationId: "conv-dev",
            title: "dev",
            isDefault: false,
            revision: 3,
            sessionState: "waiting",
            scope: { kind: "workspace", workspaceId: "/Users/james/dev" },
          },
          {
            conversationId: "global-default",
            title: "Clankie",
            isDefault: true,
            revision: 30,
            sessionState: "waiting",
            scope: { kind: "global" },
          },
        ],
        select: async (conversationId) => {
          selected.push(conversationId);
          return { conversationId, title: conversationId === "global-default" ? "Clankie" : "dev" };
        },
      },
    }).find((candidate) => candidate.name === "conversation");
    if (command === undefined) throw new Error("conversation command not found");
    const shell = {
      setupFlow: {
        begin() {},
        end() {},
        readSelect(options: NonNullable<typeof menu>) {
          menu = options;
          return Promise.resolve("global-default");
        },
      },
      insertCommandResult(invocation: string, text: string) {
        results.push({ invocation, text });
      },
    } as unknown as ClankieFaceShell;

    await command.run("", shell);
    await command.run("dev", shell);

    expect(menu).toMatchObject({
      currentValue: "conv-dev",
      initialValue: "conv-dev",
      options: [
        { label: "dev", hint: "workspace", description: "/Users/james/dev" },
        { label: "Clankie", hint: "global · default" },
      ],
    });
    expect(selected).toEqual(["global-default", "conv-dev"]);
    expect(results).toEqual([
      { invocation: "/conversation", text: "Switched to Clankie." },
      { invocation: "/conversation dev", text: "Switched to dev." },
    ]);
  });

  it("closes the hovered conversation and selects a fallback when it was current", async () => {
    let currentConversationId = "conv-dev";
    let rows = [
      {
        conversationId: "conv-dev",
        title: "dev",
        isDefault: false,
        revision: 3,
        sessionState: "waiting" as const,
        scope: { kind: "workspace" as const, workspaceId: "/Users/james/dev" },
      },
      {
        conversationId: "global-default",
        title: "Clankie",
        isDefault: true,
        revision: 30,
        sessionState: "waiting" as const,
        scope: { kind: "global" as const },
      },
    ];
    const closed: string[] = [];
    const selected: string[] = [];
    const command = buildConsoleCommands({
      conversations: {
        get conversationId() {
          return currentConversationId;
        },
        conversations: async () => rows,
        close: async (conversationId) => {
          closed.push(conversationId);
          rows = rows.filter((item) => item.conversationId !== conversationId);
          return true;
        },
        select: async (conversationId) => {
          currentConversationId = conversationId;
          selected.push(conversationId);
          return { conversationId, title: "Clankie" };
        },
      },
    }).find((candidate) => candidate.name === "conversation");
    if (command === undefined) throw new Error("conversation command not found");
    let reads = 0;
    const statuses: string[] = [];
    const shell = {
      setupFlow: {
        begin() {},
        end() {},
        renderLine(text: string) {
          statuses.push(text);
        },
        readSelect(options: Parameters<ClankieFaceShell["setupFlow"]["readSelect"]>[0]) {
          if (reads++ === 0) options.onClose?.("conv-dev");
          return Promise.resolve(undefined);
        },
      },
    } as unknown as ClankieFaceShell;

    await command.run("", shell);

    expect(closed).toEqual(["conv-dev"]);
    expect(selected).toEqual(["global-default"]);
    expect(statuses).toEqual(["Closed dev."]);
  });

  it("starts a fresh conversation in the current scope", async () => {
    const results: Array<{ invocation: string; text: string }> = [];
    const created: Array<string | undefined> = [];
    let cleared = false;
    const command = buildConsoleCommands({
      conversations: {
        conversationId: "conv-dev",
        title: "dev",
        conversations: async () => [],
        select: async (conversationId) => ({ conversationId, title: "dev" }),
        create: async (title) => {
          created.push(title);
          return { conversationId: "conv-new", title: title ?? "New chat" };
        },
      },
    }).find((candidate) => candidate.name === "new");
    if (command === undefined) throw new Error("new command not found");
    const shell = {
      clearTranscript() {
        cleared = true;
      },
      insertCommandResult(invocation: string, text: string) {
        results.push({ invocation, text });
      },
    } as unknown as ClankieFaceShell;

    await command.run("", shell);

    expect(created).toEqual([undefined]);
    expect(cleared).toBe(true);
    expect(results).toEqual([{ invocation: "/new", text: "Started New chat with fresh context." }]);
  });

  it("routes goal budgets and the autonomy kill switch through the selected conversation", async () => {
    const commands: unknown[] = [];
    const conversations = {
      conversationId: "global-default",
      conversations: async () => [],
      select: async () => ({ conversationId: "global-default", title: "Clankie" }),
      autonomy: async (command: unknown) => {
        commands.push(command);
        return { enabled: false };
      },
    };
    const built = buildConsoleCommands({ conversations });
    const shell = { insertCommandResult() {} } as unknown as ClankieFaceShell;

    await built.find((command) => command.name === "goal")!.run("--tokens 5000 inspect the release", shell);
    await built.find((command) => command.name === "autonomy")!.run("off", shell);

    expect(commands).toEqual([
      { action: "set_goal", objective: "inspect the release", tokenBudget: 5000 },
      { action: "set_enabled", enabled: false },
    ]);
  });

  it("lets an active setup prompt handle Escape", () => {
    const shell = new ClankieFaceShell({
      commands: buildConsoleCommands({}),
      cwd: process.cwd(),
      env: {},
      bannerFields: { title: "Clankie" },
    });
    vi.spyOn(shell.setupFlow, "isWaitingForInput").mockReturnValue(true);
    vi.spyOn(shell.setupFlow, "hasActivePrompt").mockReturnValue(true);
    const cancel = vi.spyOn(shell.setupFlow, "handleSubmit");

    const routed = (
      shell as unknown as { routeInput(data: string): { consume?: boolean } | undefined }
    ).routeInput("\x1b");

    expect(routed).toBeUndefined();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("always detaches an active turn on Escape", () => {
    const shell = new ClankieFaceShell({
      commands: buildConsoleCommands({}),
      cwd: process.cwd(),
      env: {},
      bannerFields: { title: "Clankie" },
    });
    const controller = new AbortController();
    const internals = shell as unknown as {
      activeTurn: { controller: AbortController };
      routeInput(data: string): { consume?: boolean } | undefined;
    };
    internals.activeTurn = { controller };

    expect(internals.routeInput("\x1b")).toEqual({ consume: true });
    expect(controller.signal.aborted).toBe(true);
  });
});
