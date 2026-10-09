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
  expect(new Set(menu.options.map((option) => option.value))).toEqual(new Set(expected));
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

function persona(personaId: string, extra: Partial<OperatorAgentPersona> = {}): OperatorAgentPersona {
  return {
    personaId,
    name: personaId,
    harness: "codex",
    updatedAt: "2026-09-30T12:00:00.000Z",
    ...extra,
  } as OperatorAgentPersona;
}

it("lists live agents and keeps past agents with a thread behind one entry", async () => {
  const agents = [
    persona("live", { activeSeatId: "term_1" }),
    persona("older", { conversationId: "older-thread", updatedAt: "2026-09-29T12:00:00.000Z" }),
    persona("newer", { conversationId: "newer-thread", updatedAt: "2026-09-30T18:00:00.000Z" }),
    persona("gone"),
  ];
  const { commands, shell, openAgent, readSelect } = setup(agents);
  readSelect.mockResolvedValueOnce("past").mockResolvedValueOnce("older");
  await commands.find((command) => command.name === "agents")!.run("", shell);
  const menus = (
    readSelect.mock.calls as unknown as [{ message: string; options: { value: string }[] }][]
  ).map(([menu]) => menu);
  expect(new Set(menus[0]!.options.map((option) => option.value))).toEqual(new Set(["live", "past"]));
  expect(new Set(menus[1]!.options.map((option) => option.value))).toEqual(new Set(["newer", "older"]));
  expect(openAgent).toHaveBeenCalledWith(agents[1]);
});

it("does not offer or open agents without a live seat or saved thread", async () => {
  const { commands, shell, readSelect, openAgent } = setup([persona("gone")]);
  await commands.find((command) => command.name === "agents")!.run("", shell);
  expect(readSelect).not.toHaveBeenCalled();
  expect(openAgent).not.toHaveBeenCalled();
});
