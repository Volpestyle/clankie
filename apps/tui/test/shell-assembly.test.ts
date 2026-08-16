/**
 * Constructs the face shell without starting it (start() needs a TTY) and
 * asserts the basic wiring: setup flow idle, default layout, and the console
 * command set feeding the typeahead/workbench.
 */
import { describe, expect, it, vi } from "vitest";
import { buildConsoleCommands } from "../src/commands.ts";
import { ClankieFaceShell } from "../src/shell/shell.ts";

describe("shell assembly", () => {
  it("wires the face shell without starting it", () => {
    const commands = buildConsoleCommands({});
    const shell = new ClankieFaceShell({
      commands,
      cwd: process.cwd(),
      env: {},
      bannerFields: { title: "Clankie", tagline: "test" },
    });
    expect(shell.setupFlow.isWaitingForInput()).toBe(false);
    expect(shell.layoutSettings.inputPlacement).toBe("bottom");
  });

  it("builds a console command set with names and descriptions", () => {
    const commands = buildConsoleCommands({});
    expect(commands.length).toBeGreaterThanOrEqual(8);
    for (const command of commands) {
      expect(command.name.length).toBeGreaterThan(0);
      expect(command.description.length).toBeGreaterThan(0);
    }
  });

  it("shows readable conversations without internal ids or revisions", async () => {
    const results: Array<{ invocation: string; text: string }> = [];
    const selected: string[] = [];
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
            scope: { kind: "workspace", workspaceId: "/Users/james/dev" },
          },
          {
            conversationId: "global-default",
            title: "Clankie",
            isDefault: true,
            revision: 30,
            scope: { kind: "global" },
          },
        ],
        select: async (conversationId) => {
          selected.push(conversationId);
          return { conversationId, title: "dev" };
        },
      },
    }).find((candidate) => candidate.name === "conversation");
    if (command === undefined) throw new Error("conversation command not found");
    const shell = {
      insertCommandResult(invocation: string, text: string) {
        results.push({ invocation, text });
      },
    } as unknown as ClankieFaceShell;

    await command.run("", shell);
    await command.run("dev", shell);

    expect(results[0]).toEqual({
      invocation: "/conversation",
      text: [
        "● dev · current",
        "  Workspace · /Users/james/dev",
        "○ Clankie",
        "  Global · default",
        "",
        "Switch with /conversation <name> or /cd <path>.",
      ].join("\n"),
    });
    expect(results[0]?.text).not.toMatch(/conv-dev|global-default|revision/u);
    expect(selected).toEqual(["conv-dev"]);
    expect(results[1]).toEqual({ invocation: "/conversation dev", text: "Switched to dev." });
  });

  it("lets an active setup prompt handle Escape", () => {
    const shell = new ClankieFaceShell({
      commands: buildConsoleCommands({}),
      cwd: process.cwd(),
      env: {},
      bannerFields: { title: "Clankie", tagline: "test" },
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
});
