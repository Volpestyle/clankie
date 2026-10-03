import { expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { LiveAgentStrip } from "../src/shell/live-agents.ts";
import { ClankieFaceShell } from "../src/shell/shell.ts";
import type { LiveAgent } from "../src/observation/herdr-roster.ts";

const agent = (id: string, remote = false): LiveAgent => ({
  name: `Worker ${id}`,
  seat: {
    seatId: remote ? `pc/${id}` : id,
    personaId: id,
    occupantId: id,
    harness: "codex",
    status: "working",
    title: "Checking native delivery",
    ...(remote ? { fleet: "pc", machine: "Office PC" } : {}),
  },
});

it("bounds the strip, keeps selection across updates and reaches every qualified machine identity", () => {
  let agents = [agent("same"), agent("same", true), agent("third"), agent("fourth")];
  const strip = new LiveAgentStrip(() => agents);
  expect(strip.render(100).join("\n")).toContain("Office PC");
  expect(strip.render(100).join("\n")).toContain("Checking native delivery");
  strip.move(1);
  expect(strip.selected()?.seat.seatId).toBe("pc/same");
  agents = [agent("new"), ...agents];
  expect(strip.selected()?.seat.seatId).toBe("pc/same");
  strip.move(2);
  expect(strip.selected()?.seat.seatId).toBe("fourth");
  expect(strip.render(32)).toHaveLength(4);
  expect(strip.render(32).every((row) => visibleWidth(row) <= 32)).toBe(true);
  agents = [];
  expect(strip.render(80)).toEqual([]);
  expect(strip.selected()).toBeUndefined();
});

it("routes focus, expand, Escape and workspace without sending keys or interrupting the agent", async () => {
  let expanded: string | undefined;
  const open = vi.fn(async (value: LiveAgent) => {
    expanded = value.name;
  });
  const leave = vi.fn(async () => {
    expanded = undefined;
  });
  const workspace = vi.fn(async () => {});
  const interrupt = vi.fn(async () => true);
  const shell = new ClankieFaceShell({
    commands: [],
    cwd: process.cwd(),
    env: {},
    bannerFields: { title: "Clankie" },
    liveAgents: () => [agent("same"), agent("same", true)],
    expandedAgent: () => expanded,
    onOpenLiveAgent: open,
    onLeaveLiveAgent: leave,
    onOpenAgentWorkspace: workspace,
    onInterrupt: interrupt,
  });
  const ui = shell as unknown as {
    routeInput(data: string): unknown;
    editor: { setText(text: string): void; getText(): string };
    liveAgents: LiveAgentStrip;
    agentNavigationBusy: boolean;
  };
  ui.editor.setText("unfinished draft");
  expect(ui.routeInput("\x07")).toEqual({ consume: true });
  expect(ui.liveAgents.focused).toBe(true);
  ui.routeInput("\x1b[B");
  ui.routeInput("\r");
  await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
  expect(open.mock.calls[0]?.[0].seat.seatId).toBe("pc/same");
  expect(ui.editor.getText()).toBe("unfinished draft");
  await vi.waitFor(() => expect(ui.agentNavigationBusy).toBe(false));
  ui.routeInput("\x19");
  await vi.waitFor(() => expect(workspace).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(ui.agentNavigationBusy).toBe(false));
  ui.routeInput("\x1b");
  await vi.waitFor(() => expect(leave).toHaveBeenCalledOnce());
  expect(interrupt).not.toHaveBeenCalled();
});
