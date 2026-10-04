import { expect, it, vi } from "vitest";
import { stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { LiveAgentPicker, LiveAgentStrip } from "../src/shell/live-agents.ts";
import { ClankieFaceShell } from "../src/shell/shell.ts";
import type { LiveAgent } from "../src/observation/herdr-roster.ts";
import { createClankieFaceAnsiTheme } from "../src/face/clankie-face-theme.ts";

const ansi = createClankieFaceAnsiTheme({ color: true, trueColor: true });
const theme = {
  ansi,
  selectListTheme: {
    description: ansi.dim,
    noMatch: ansi.dim,
    scrollInfo: ansi.dim,
    selectedPrefix: ansi.cyan,
    selectedText: ansi.bold,
  },
};
const plain = (rows: string[]) => rows.map(stripTerminalSequences).join("\n");

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

it("bounds the strip to two rows and preserves qualified selection across updates", () => {
  let agents = [agent("same"), agent("same", true), agent("third"), agent("fourth")];
  const strip = new LiveAgentStrip(() => agents, theme);
  strip.select("pc/same");
  expect(plain(strip.render(120))).toContain("Office PC");
  expect(plain(strip.render(120))).not.toContain("Checking native delivery");
  expect(strip.selected()?.seat.seatId).toBe("pc/same");
  agents = [agent("new"), ...agents];
  expect(strip.selected()?.seat.seatId).toBe("pc/same");
  for (const width of [1, 24, 32, 80, 120]) {
    expect(strip.render(width)).toHaveLength(2);
    expect(strip.render(width).every((row) => visibleWidth(row) <= width)).toBe(true);
  }
  expect(plain(strip.render(32))).toContain("ctrl+g");
  agents = [agent("third")];
  expect(strip.selected()?.seat.seatId).toBe("third");
  agents = [];
  expect(strip.render(80)).toEqual([]);
  expect(strip.selected()).toBeUndefined();
});

it("uses theme colors for each status, harness and machine and suppresses repeated steps", () => {
  const agents = ["working", "idle", "done", "blocked"].map((status) => ({
    ...agent(status, true),
    seat: { ...agent(status, true).seat, status: status as LiveAgent["seat"]["status"] },
  }));
  const strip = new LiveAgentStrip(() => agents, theme);
  const summary = strip.render(160)[0]!;
  expect(summary).toContain(ansi.accent("1 working"));
  expect(summary).toContain(ansi.yellow("1 idle"));
  expect(summary).toContain(ansi.green("1 done"));
  expect(summary).toContain(ansi.red("1 blocked"));
  expect(strip.render(160)[1]).toContain(ansi.blue("codex"));
  expect(strip.render(160)[1]).toContain(ansi.dim("Office PC"));

  const repeated = agent("repeat");
  const dock = new LiveAgentStrip(
    () => [
      {
        ...repeated,
        name: repeated.seat.title,
        seat: {
          ...repeated.seat,
          summary: repeated.seat.title,
          stance: {
            pose: "working",
            statedAt: "2026-10-04T12:00:00.000Z",
            expiresAt: "2026-10-04T13:00:00.000Z",
            note: repeated.seat.title,
          },
        },
      },
    ],
    theme,
  );
  expect(plain(dock.render(180)).split(repeated.seat.title)).toHaveLength(2);
});

it.each([32, 120])("scrolls through the entire fleet with full selected details at width %i", (width) => {
  let agents = Array.from({ length: 20 }, (_, i) => agent(`seat-${i}`));
  const last = agent("seat-19", true);
  agents[19] = {
    ...last,
    name: "Continue KH2 agent coordination | repos",
    seat: {
      ...last.seat,
      title: "Continue KH2 agent coordination | repos",
      stance: {
        pose: "working",
        statedAt: "2026-10-04T12:00:00.000Z",
        expiresAt: "2026-10-04T13:00:00.000Z",
        note: "Checking remote native delivery",
      },
    },
  };
  const strip = new LiveAgentStrip(() => agents, theme);
  const open = vi.fn();
  const close = vi.fn();
  const picker = new LiveAgentPicker(() => agents, strip, theme, {
    maxHeight: () => 26,
    onOpen: open,
    onClose: close,
    onRender: () => {},
  });
  for (let i = 0; i < 19; i++) picker.handleInput("\x1b[B");
  expect(strip.selected()?.seat.seatId).toBe("pc/seat-19");
  const rows = picker.render(width);
  expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
  expect(rows.length).toBeLessThanOrEqual(26);
  const text = plain(rows);
  expect(text).toContain("20/20");
  expect(text).toContain("Office PC");
  expect(text.replace(/[│\n]/gu, " ").replace(/\s+/gu, " ")).toContain("Checking remote native delivery");
  // Reordering the feed cannot redirect Enter to another seat with the same pane id.
  agents = [agent("seat-19"), ...agents.toReversed()];
  picker.handleInput("\r");
  expect(open.mock.calls[0]?.[0].seat.seatId).toBe("pc/seat-19");
  picker.handleInput("\x1b");
  expect(close).toHaveBeenCalledOnce();
  agents = [];
  expect(plain(picker.render(width))).toContain("No agents are seated");
  picker.handleInput("\r");
  expect(open).toHaveBeenCalledOnce();
});

it.each([32, 120])("places the dock below the prompt at width %i", (width) => {
  const shell = new ClankieFaceShell({
    commands: [],
    cwd: process.cwd(),
    env: { CLANKIE_HEADER: "off" },
    bannerFields: { title: "Clankie" },
    liveAgents: () => [agent("layout")],
  });
  vi.spyOn(shell.tui, "start").mockImplementation(() => {});
  shell.setDraft("A draft above the agents");
  shell.start();
  const rows = shell.tui.render(width);
  const text = plain(rows);
  expect(text.indexOf("A draft above the agents")).toBeGreaterThanOrEqual(0);
  expect(text.indexOf("Agents · 1")).toBeGreaterThan(text.indexOf("A draft above the agents"));
  expect(rows.every((row) => visibleWidth(row) <= width)).toBe(true);
});

it("opens a real overlay, restores editor focus and navigates without interrupting the agent", async () => {
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
    agentNavigationBusy: boolean;
    activeTurn: { controller: AbortController };
  };
  let picker: Component | undefined;
  const show = vi.spyOn(shell, "showModalOverlay").mockImplementation((component, options) => {
    expect(options?.anchor).toBe("center");
    picker = component;
    return shell.tui.showOverlay(component, options);
  });
  ui.editor.setText("unfinished draft");
  ui.activeTurn = { controller: new AbortController() };
  expect(ui.routeInput("\x07")).toEqual({ consume: true });
  expect(show).toHaveBeenCalledOnce();
  expect(shell.tui.hasOverlay()).toBe(true);
  // Global shortcuts must leave keys to the capturing modal.
  expect(ui.routeInput("\x1b")).toBeUndefined();
  expect(ui.routeInput("\x03")).toBeUndefined();
  expect(interrupt).not.toHaveBeenCalled();
  expect(ui.activeTurn.controller.signal.aborted).toBe(false);
  picker!.handleInput!("\x1b[B");
  picker!.handleInput!("\x1b");
  expect(shell.tui.hasOverlay()).toBe(false);
  expect(open).not.toHaveBeenCalled();
  expect(ui.editor.getText()).toBe("unfinished draft");
  ui.routeInput("\x07");
  picker!.handleInput!("\r");
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

it("renders a remote agent refusal as a readable message without its JSON envelope", async () => {
  const shell = new ClankieFaceShell({
    commands: [],
    cwd: process.cwd(),
    env: {},
    bannerFields: { title: "Clankie" },
    liveAgents: () => [agent("w3:p8", true)],
    onOpenLiveAgent: async () => {
      throw new Error(
        '{"error":{"code":"agent_not_found","message":"agent target kh2/w3:p8 not found"},"id":"cli:agent:get"}',
      );
    },
  });
  const result = vi.spyOn(shell, "insertCommandResult");
  let picker: Component | undefined;
  vi.spyOn(shell, "showModalOverlay").mockImplementation((component, options) => {
    picker = component;
    return shell.tui.showOverlay(component, options);
  });
  (shell as unknown as { routeInput(data: string): unknown }).routeInput("\x07");
  picker!.handleInput!("\r");
  await vi.waitFor(() =>
    expect(result).toHaveBeenCalledWith("Agents", "agent target kh2/w3:p8 not found", "error"),
  );
  expect(shell.tui.hasOverlay()).toBe(false);
});

it("flags a missing bridge and reveals the entire selected fix within narrow widths", () => {
  const worker = agent("gap");
  const agents = [
    {
      ...worker,
      seat: {
        ...worker.seat,
        harnessBridge: {
          status: "missing" as const,
          detail: "No bridge process",
          remediation: "Save sessions; codex app-server daemon stop; codex --no-daemon resume <SESSION>",
        },
      },
    },
  ];
  const strip = new LiveAgentStrip(() => agents, theme);
  expect(plain(strip.render(120))).toContain("bridge missing");
  const picker = new LiveAgentPicker(() => agents, strip, theme, {
    maxHeight: () => 30,
    onOpen: () => {},
    onClose: () => {},
    onRender: () => {},
  });
  const narrow = picker.render(40);
  expect(narrow.every((row) => visibleWidth(row) <= 40)).toBe(true);
  expect(
    plain(narrow)
      .replace(/[│\n]/gu, " ")
      .replace(/\s+/gu, " "),
  ).toContain("codex --no-daemon resume");
});
