import { expect, it, vi } from "vitest";
import { stripTerminalSequences, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { ConversationHeader, LiveAgentPicker, LiveAgentStrip } from "../src/shell/live-agents.ts";
import { ClankieFaceShell } from "../src/shell/shell.ts";
import { OperatorConversationSchema } from "@clankie/protocol";
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

const roomHandoff = (id: string, source: "voice" | "text", completed = false) =>
  OperatorConversationSchema.parse({
    schemaVersion: 1,
    conversationId: id,
    scope: { kind: "global" },
    title: `Room job ${id}`,
    isDefault: false,
    createdAt: "2026-10-05T12:00:00.000Z",
    updatedAt: "2026-10-05T12:01:00.000Z",
    sessionState: "waiting",
    revision: 1,
    roomHandoff: {
      roomConversationId: "room-voice",
      deliveryId: `delivery-${id}`,
      actorId: id,
      actorName: source === "voice" ? "James" : "Mira",
      source,
      request: source === "voice" ? "Check the bakery hours" : "Find the train times",
      doing: "Reading the source",
      state: completed ? "completed" : "running",
      host: source === "voice" ? "codex" : "pi",
      ...(source === "voice" ? { nativeChildSessionId: `native-${id}` } : {}),
      ...(completed ? { result: "The last train leaves at 10." } : {}),
    },
  });

it("prioritizes active handoffs in the dock and keeps finished results selectable in the picker", async () => {
  const handoffs = [roomHandoff("voice-child", "voice"), roomHandoff("text-child", "text", true)];
  const open = vi.fn(async (_conversation: ReturnType<typeof roomHandoff>) => {});
  const openSeat = vi.fn(async () => {});
  const shell = new ClankieFaceShell({
    commands: [],
    cwd: process.cwd(),
    env: {},
    bannerFields: { title: "Clankie" },
    liveAgents: () => [],
    roomHandoffs: () => handoffs,
    onOpenRoomHandoff: open,
    onOpenLiveAgent: openSeat,
  });
  vi.spyOn(shell.tui, "start").mockImplementation(() => {});
  shell.start();
  const rows = plain(shell.tui.render(180));
  expect(rows).toContain("↳ Clankie · Check the bakery hours");
  expect(rows).toContain("Asked by James · running");
  expect(rows).not.toContain("Asked by Mira · completed");
  expect(rows).not.toContain("The last train leaves at 10.");
  const ui = shell as unknown as { routeInput(data: string): unknown };
  const showPicker = vi.spyOn(shell, "showModalOverlay");
  ui.routeInput("\x07");
  expect(showPicker).toHaveBeenCalledOnce();
  const roomPicker = showPicker.mock.calls[0]![0];
  expect(plain(roomPicker.render(180))).toContain("Asked by Mira · completed");
  roomPicker.handleInput?.("\x1b[B");
  roomPicker.handleInput?.("\r");
  await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
  expect(open.mock.calls[0]?.[0]).toBe(handoffs[1]);
  expect(openSeat).not.toHaveBeenCalled();

  const seats = [agent("working")];
  const strip = new LiveAgentStrip(() => seats, theme, { roomHandoffs: () => handoffs });
  expect(plain(strip.render(180))).toContain("Worker working");
  expect(plain(strip.render(180))).not.toContain("completed");
  strip.select("handoff:text-child");
  const pickerOpen = vi.fn();
  const picker = new LiveAgentPicker(() => seats, strip, theme, {
    maxHeight: () => 35,
    onOpen: () => {},
    onOpenHandoff: pickerOpen,
    onClose: () => {},
    onRender: () => {},
  });
  const details = plain(picker.render(100));
  expect(details).toContain("Asked by: Mira · text");
  expect(details).toContain("Job: Find the train times");
  expect(details).toContain("Doing: Reading the source");
  expect(details).toContain("Result: The last train leaves at 10.");
  picker.handleInput("\r");
  expect(pickerOpen).toHaveBeenCalledExactlyOnceWith(handoffs[1]);
  for (const width of [24, 40, 100]) {
    expect(strip.render(width).every((row) => visibleWidth(row) <= width)).toBe(true);
    expect(picker.render(width).every((row) => visibleWidth(row) <= width)).toBe(true);
  }
});

it("lists up to three seats that want attention and expands to the whole fleet in place", () => {
  const status = (id: string, value: string, remote = false): LiveAgent => ({
    ...agent(id, remote),
    seat: {
      ...agent(id, remote).seat,
      status: value as LiveAgent["seat"]["status"],
    },
  });
  let agents = [
    status("idle-1", "idle"),
    status("done", "done"),
    status("working", "working", true),
    status("blocked", "blocked"),
    status("idle-2", "idle"),
  ];
  const strip = new LiveAgentStrip(() => agents, theme, { maxRows: () => 3 });
  const collapsed = plain(strip.render(120)).split("\n");
  // Blocked first, then working, then done; idle seats only count.
  expect(collapsed.slice(1).map((row) => row.split(" · ")[0])).toEqual([
    "● Worker blocked",
    "● Worker working",
    "● Worker done",
  ]);
  expect(collapsed[2]).toContain("Office PC");
  expect(plain(strip.render(120))).not.toContain("Worker idle");
  for (const width of [1, 24, 32, 80, 120])
    expect(strip.render(width).every((row) => visibleWidth(row) <= width)).toBe(true);

  expect(strip.focus()).toBe(true);
  expect(strip.selected()?.seat.seatId).toBe("blocked");
  for (let i = 0; i < 4; i++) expect(strip.handleInput("\x1b[B")).toBe("consumed");
  expect(strip.selected()?.seat.seatId).toBe("idle-2");
  const expanded = plain(strip.render(120));
  expect(expanded).toContain("5/5");
  expect(expanded).toContain("› ● Worker idle-2");
  expect(strip.render(120)).toHaveLength(3);
  // A reorder keeps the same seat selected.
  agents = [status("new", "working"), ...agents];
  expect(strip.selected()?.seat.seatId).toBe("idle-2");
  expect(strip.handleInput("\r")).toBe("open");
  expect(strip.focused).toBe(false);

  strip.focus();
  expect(strip.handleInput("\x1b[A")).toBe("leave");
  strip.focus();
  expect(strip.handleInput("x")).toBe("pass");
  expect(strip.focused).toBe(false);
  agents = [];
  expect(strip.render(80)).toEqual([]);
  expect(strip.focus()).toBe(false);
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

it("enters the inline agent list only from an empty prompt and opens the chosen seat", async () => {
  let expanded: LiveAgent | undefined;
  const open = vi.fn(async (value: LiveAgent) => {
    expanded = value;
  });
  const shell = new ClankieFaceShell({
    commands: [],
    cwd: process.cwd(),
    env: { CLANKIE_HEADER: "off" },
    bannerFields: { title: "Clankie" },
    liveAgents: () => [agent("first"), agent("second")],
    onOpenLiveAgent: open,
    expandedAgent: () => expanded?.name,
    expandedAgentSeatId: () => expanded?.seat.seatId,
  });
  vi.spyOn(shell.tui, "start").mockImplementation(() => {});
  shell.start();
  const ui = shell as unknown as { routeInput(data: string): unknown };
  shell.setDraft("still typing");
  expect(ui.routeInput("\x1b[B")).toBeUndefined();
  shell.setDraft("");
  expect(ui.routeInput("\x1b[B")).toEqual({ consume: true });
  expect(plain(shell.tui.render(120))).toContain("esc back");
  ui.routeInput("\x1b[B");
  ui.routeInput("\r");
  await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
  expect(open.mock.calls[0]?.[0].seat.seatId).toBe("second");
  const rows = shell.tui.render(120);
  expect(plain(rows)).not.toContain("esc back");
  // The fixed header names the agent on screen and the way home, in its harness tint.
  expect(stripTerminalSequences(rows[0]!)).toContain("◀ esc Clankie › Worker second");
  expect(stripTerminalSequences(rows[1]!)).toMatch(/^━+$/u);
  const header = new ConversationHeader(theme, () => ({ agent: { name: "Worker", live: agent("w") } }));
  expect(header.render(40)[1]).toBe(ansi.blue("━".repeat(40)));
  expect(plain(new ConversationHeader(theme, () => ({ title: "Main" })).render(40))).toContain(
    "Clankie · Main",
  );
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

it("shows an older operator bridge separately from a healthy worker and reveals the seat restart fix", () => {
  const worker = agent("older-seat");
  const agents = [
    {
      ...worker,
      seat: {
        ...worker.seat,
        harnessBridge: {
          status: "live-process" as const,
          detail: "Worker transport observed",
          freshness: "current" as const,
          operatorBridge: {
            status: "live-process" as const,
            detail: "Operator transport observed; channel polling unverified",
            freshness: "older-than-runtime" as const,
            remediation:
              "Seat bridge older than runtime; restart the seat. Process age is not obsolete-build proof.",
          },
        },
      },
    },
  ];
  const strip = new LiveAgentStrip(() => agents, theme);
  expect(plain(strip.render(150))).toContain("seat bridge older than runtime");
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
  ).toContain("restart the seat");
  const unknown: LiveAgent = {
    ...agents[0]!,
    seat: {
      ...agents[0]!.seat,
      harnessBridge: {
        ...agents[0]!.seat.harnessBridge,
        operatorBridge: { ...agents[0]!.seat.harnessBridge.operatorBridge, freshness: "unknown" },
      },
    },
  };
  expect(plain(new LiveAgentStrip(() => [unknown], theme).render(150))).not.toContain("older than runtime");
});

it.each(["current", "unknown"] as const)(
  "keeps %s worker and operator timings from producing a restart hint",
  (freshness) => {
    const worker = agent("no-age-warning");
    const agents: LiveAgent[] = [
      {
        ...worker,
        seat: {
          ...worker.seat,
          harnessBridge: {
            status: "live-process",
            detail: "Worker transport observed; delivery unverified",
            freshness,
            operatorBridge: {
              status: "live-process",
              detail: "Operator transport observed; polling unverified",
              freshness,
            },
          },
        },
      },
    ];
    const strip = new LiveAgentStrip(() => agents, theme);
    const picker = new LiveAgentPicker(() => agents, strip, theme, {
      maxHeight: () => 30,
      onOpen: () => {},
      onClose: () => {},
      onRender: () => {},
    });
    for (const rows of [strip.render(150), picker.render(150)]) {
      expect(plain(rows)).not.toContain("older than runtime");
      expect(plain(rows)).not.toContain("restart the seat");
      expect(plain(rows)).not.toContain("Fix:");
    }
  },
);

it.each(["worker", "both"])("shows the seat restart action when %s bridge processes are older", (older) => {
  const worker = agent("old-worker");
  const agents: LiveAgent[] = [
    {
      ...worker,
      seat: {
        ...worker.seat,
        harnessBridge: {
          status: "live-process",
          detail: "Worker transport observed; delivery unverified",
          freshness: "older-than-runtime",
          remediation: "Worker seat bridge older than runtime; restart the seat to reload its bridge.",
          operatorBridge: {
            status: "live-process",
            detail: "Operator transport observed; polling unverified",
            freshness: older === "both" ? "older-than-runtime" : "current",
            ...(older === "both"
              ? {
                  remediation:
                    "Operator seat bridge older than runtime; restart the seat to reload its bridge.",
                }
              : {}),
          },
        },
      },
    },
  ];
  const strip = new LiveAgentStrip(() => agents, theme);
  expect(plain(strip.render(150))).toContain("seat bridge older than runtime");
  expect(plain(strip.render(150))).not.toContain("bridge missing");
  const picker = new LiveAgentPicker(() => agents, strip, theme, {
    maxHeight: () => 30,
    onOpen: () => {},
    onClose: () => {},
    onRender: () => {},
  });
  const rows = picker.render(40);
  expect(rows.every((row) => visibleWidth(row) <= 40)).toBe(true);
  const text = plain(rows)
    .replace(/[│\n]/gu, " ")
    .replace(/\s+/gu, " ");
  expect(text).toContain("restart the seat to reload its bridge");
  expect(text).toContain(`${older === "both" ? "Operator" : "Worker"} seat bridge older than runtime`);
});

it.each(["mismatch", "unverified"] as const)(
  "shows %s native tools above healthy workers and the one fix at narrow widths",
  (status) => {
    const worker = agent("native-gap");
    const agents: LiveAgent[] = [
      agent("healthy"),
      {
        ...worker,
        seat: {
          ...worker.seat,
          harnessBridge: { status: "live-process", detail: "Bridge exists" },
          toolCatalog: {
            status,
            harness: "codex",
            bridge: "worker",
            sessionId: worker.seat.occupantId,
            detail:
              status === "mismatch"
                ? "Codex is missing clankie_call."
                : "Embedded Codex catalog cannot be verified.",
            missing: status === "mismatch" ? ["clankie_call"] : [],
            remediation: "Ask Clankie to hire this Codex seat with hire_agent for a verified catalog.",
          },
        },
      },
    ];
    const strip = new LiveAgentStrip(() => agents, theme);
    expect(strip.selected()?.seat.seatId).toBe("native-gap");
    expect(plain(strip.render(120))).toContain(`Clankie tools ${status}`);
    const picker = new LiveAgentPicker(() => agents, strip, theme, {
      maxHeight: () => 30,
      onOpen() {},
      onClose() {},
      onRender() {},
    });
    const narrow = picker.render(40);
    expect(narrow.every((row) => visibleWidth(row) <= 40)).toBe(true);
    const text = plain(narrow)
      .replace(/[│\n]/gu, " ")
      .replace(/\s+/gu, " ");
    expect(text).toContain(agents[1]!.seat.toolCatalog!.detail);
    expect(text).toContain("Ask Clankie to hire this Codex seat with hire_agent for a verified catalog.");
    expect(text).not.toContain("daemon");
  },
);

it("keeps the catalog fixing action visible when the entire server was rejected", () => {
  const worker = agent("whole-server");
  const agents: LiveAgent[] = [
    {
      ...worker,
      seat: {
        ...worker.seat,
        toolCatalog: {
          status: "mismatch",
          harness: "claude",
          bridge: "operator",
          missing: ["hire_agent", "reply"],
          detail: `Native Claude is missing its catalog: ${"missing_tool_name ".repeat(150)}`,
          remediation: "Run /reload-plugins in this pane to recheck its tools.",
        },
      },
    },
  ];
  const strip = new LiveAgentStrip(() => agents, theme);
  const picker = new LiveAgentPicker(() => agents, strip, theme, {
    maxHeight: () => 30,
    onOpen() {},
    onClose() {},
    onRender() {},
  });
  const rendered = picker.render(40);
  expect(rendered.length).toBeLessThanOrEqual(30);
  expect(rendered.every((row) => visibleWidth(row) <= 40)).toBe(true);
  expect(
    plain(rendered)
      .replace(/[│\n]/gu, " ")
      .replace(/\s+/gu, " "),
  ).toContain("Run /reload-plugins in this pane to recheck its tools.");
});

it("prioritizes efficiency concerns and shows every plain flag in narrow selected-seat details", () => {
  const flagged = agent("flagged");
  flagged.seat.efficiency = {
    checkedAt: "2026-10-05T12:00:00.000Z",
    ownerConversationId: "global-default",
    flags: ["off-scope", "reports failing", "context 80%", "no progress in 2h"],
  };
  const agents = [agent("ordinary"), flagged];
  const strip = new LiveAgentStrip(() => agents, theme);
  expect(strip.selected()?.seat.seatId).toBe("flagged");
  const picker = new LiveAgentPicker(() => agents, strip, theme, {
    maxHeight: () => 30,
    onOpen: () => {},
    onClose: () => {},
    onRender: () => {},
  });
  const rendered = plain(picker.render(40));
  for (const flag of flagged.seat.efficiency.flags) expect(rendered).toContain(flag);
  expect(picker.render(40).every((line) => visibleWidth(line) <= 40)).toBe(true);
});
