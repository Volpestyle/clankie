import { expect, it, vi } from "vitest";
import type { OperatorAgentPersona, OperatorConversationScope } from "@clankie/protocol";
import { buildConsoleCommands, type ConsoleCommandContext } from "../src/commands.ts";
import type { ClankieFaceShell } from "../src/shell/shell.ts";

const scopes: OperatorConversationScope[] = [
  { kind: "global" },
  { kind: "workspace", workspaceId: "/repo" },
  { kind: "persona", personaId: "agent-one" },
  { kind: "seat", seatId: "seat-one" },
  { kind: "channel", channelId: "team" },
  { kind: "room", lane: "discord_presence", targetId: "discord:123" },
];
const rows = scopes.map((scope) => ({
  conversationId: scope.kind,
  title: scope.kind,
  scope,
  isDefault: scope.kind === "global",
  revision: 0,
  sessionState: "waiting" as const,
}));
function setup(agents: OperatorAgentPersona[] = [], picked?: string) {
  const readSelect = vi.fn(async () => picked);
  const renderLine = vi.fn();
  const select = vi.fn(async (conversationId: string) => ({ conversationId, title: conversationId }));
  const openAgent = vi.fn(async (agent: OperatorAgentPersona) => ({ title: agent.name }));
  const context: ConsoleCommandContext = {
    conversations: {
      conversationId: "persona",
      conversations: async () => rows,
      select,
      agents: async () => agents,
      openAgent,
    },
  };
  const shell = {
    setupFlow: { begin: vi.fn(), end: vi.fn(), renderLine, readSelect },
    insertCommandResult: vi.fn(),
  } as unknown as ClankieFaceShell;
  const commands = buildConsoleCommands(context);
  return { commands, shell, readSelect, renderLine, select, openAgent };
}

it.each([
  ["chats", ["global", "workspace"]],
  ["rooms", ["channel", "room"]],
  ["history", scopes.map((scope) => scope.kind)],
] as const)("%s shows the right thread types", async (name, expected) => {
  const { commands, shell, readSelect } = setup();
  await commands.find((command) => command.name === name)!.run("", shell);
  const menu = (
    readSelect.mock.calls as unknown as [{ options: { value: string }[]; currentValue?: string }][]
  )[0]![0];
  expect(menu.options.map((option) => option.value)).toEqual(expected);
  expect(menu.currentValue).toBe(name === "history" ? "persona" : undefined);
});

it("keeps agent threads out of direct chat selection but reachable in history", async () => {
  const { commands, shell, select } = setup();
  await commands.find((command) => command.name === "chats")!.run("persona", shell);
  expect(select).not.toHaveBeenCalled();
  await commands.find((command) => command.name === "history")!.run("persona", shell);
  expect(select).toHaveBeenCalledWith("persona");
  expect(commands.find((command) => command.name === "chats")!.aliases).toContain("conversation");
});

it.each([false, true])("only opens offline agents when a saved thread exists: %s", async (saved) => {
  const agent = {
    personaId: "offline",
    name: "Reviewer",
    harness: "codex",
    ...(saved ? { conversationId: "saved-thread" } : {}),
  } as OperatorAgentPersona;
  const { commands, shell, openAgent, readSelect } = setup([agent], "offline");
  await commands.find((command) => command.name === "agents")!.run("", shell);
  expect(openAgent).toHaveBeenCalledTimes(saved ? 1 : 0);
  expect(readSelect).toHaveBeenCalledWith(
    expect.objectContaining({ options: [expect.objectContaining({ hint: "Herdr · codex · offline" })] }),
  );
});

it("opens available Swarm agents without requiring an existing thread", async () => {
  const agent = {
    personaId: "peer",
    name: "Reviewer",
    harness: "swarm",
    swarm: { connectionId: "remote", available: true },
  } as OperatorAgentPersona;
  const { commands, shell, openAgent, readSelect } = setup([agent], "peer");
  await commands.find((command) => command.name === "agents")!.run("", shell);
  expect(openAgent).toHaveBeenCalledWith(agent);
  expect(readSelect).toHaveBeenCalledWith(
    expect.objectContaining({ options: [expect.objectContaining({ hint: "Swarm · remote · available" })] }),
  );
});
