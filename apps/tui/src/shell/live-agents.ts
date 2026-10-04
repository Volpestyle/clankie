import {
  SelectList,
  stripTerminalSequences,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import type { LiveAgent } from "../observation/herdr-roster.ts";
import { renderClankieOutline } from "../face/clankie-outline.ts";
import type { FaceThemeBundle } from "./theme.ts";

type AgentTheme = Pick<FaceThemeBundle, "ansi" | "selectListTheme">;

// Fleet metadata is external text; keep it from introducing terminal controls or rows.
function clean(text: string): string {
  return stripTerminalSequences(text)
    .replace(/[\r\n\t]/gu, " ")
    .trim();
}

/** A title describes the assignment, not progress. Only show a distinct current step. */
function currentStep({ name, seat }: LiveAgent): string | undefined {
  const repeated = new Set([name, seat.title].map((text) => clean(text).toLowerCase()));
  return [seat.stance?.note, seat.summary]
    .filter((text): text is string => !!text)
    .map(clean)
    .find((text) => text.length > 0 && !repeated.has(text.toLowerCase()));
}

function statusText(status: LiveAgent["seat"]["status"], text: string, { ansi }: AgentTheme): string {
  switch (status) {
    case "working":
      return ansi.accent(text);
    case "idle":
      return ansi.yellow(text);
    case "done":
      return ansi.green(text);
    case "blocked":
      return ansi.red(text);
    default:
      return ansi.dim(text);
  }
}

/** A pane whose harness bridge is missing or claims another pane, as doctor observed it (VUH-1587). */
function bridgeWarning({ seat }: LiveAgent, { ansi }: AgentTheme): string | undefined {
  const bridge = seat.harnessBridge;
  if (!bridge || bridge.status === "live-process" || bridge.status === "unobserved") return undefined;
  return ansi.red(`bridge ${clean(bridge.status)}`);
}

function agentMetadata(agent: LiveAgent, theme: AgentTheme): string {
  const { seat } = agent;
  const harness = clean(seat.harness);
  const paintHarness = harness === "claude" ? theme.ansi.yellow : theme.ansi.blue;
  return [
    paintHarness(harness),
    statusText(seat.status, clean(seat.status), theme),
    theme.ansi.dim(clean(seat.machine ?? seat.fleet ?? "local")),
    bridgeWarning(agent, theme),
  ]
    .filter((part): part is string => part !== undefined)
    .join(theme.ansi.dim(" · "));
}

/** The compact preview and the modal share a qualified seat identity, never a row index. */
export class LiveAgentStrip implements Component {
  private selectedId: string | undefined;
  private readonly agents: () => readonly LiveAgent[];
  private readonly theme: AgentTheme;

  constructor(agents: () => readonly LiveAgent[], theme: AgentTheme) {
    this.agents = agents;
    this.theme = theme;
  }

  selected(): LiveAgent | undefined {
    const agents = this.agents();
    const selected = agents.find((agent) => agent.seat.seatId === this.selectedId) ?? agents[0];
    this.selectedId = selected?.seat.seatId;
    return selected;
  }

  select(seatId: string): void {
    this.selectedId = seatId;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const agents = this.agents();
    const selected = this.selected();
    if (!selected) return [];
    const counts = new Map<LiveAgent["seat"]["status"], number>();
    for (const { seat } of agents) counts.set(seat.status, (counts.get(seat.status) ?? 0) + 1);
    const summary = [...counts].map(([status, count]) =>
      statusText(status, `${count} ${status}`, this.theme),
    );
    const step = currentStep(selected);
    return [
      `${this.theme.ansi.bold(`Agents · ${agents.length}`)}${this.theme.ansi.dim(" · ctrl+g")}${this.theme.ansi.dim(" · ")}${summary.join(this.theme.ansi.dim(" · "))}`,
      `${statusText(selected.seat.status, "●", this.theme)} ${clean(selected.name)} · ${agentMetadata(selected, this.theme)}${step ? ` · ${step}` : ""}`,
    ].map((line) => truncateToWidth(line, Math.max(1, width), "…"));
  }
}

/** Native selector in the same outlined, centered modal as the setup flow. */
export class LiveAgentPicker implements Component {
  focused = false;
  private readonly agents: () => readonly LiveAgent[];
  private readonly selection: LiveAgentStrip;
  private readonly theme: AgentTheme;
  private readonly options: {
    readonly maxHeight: () => number;
    readonly onOpen: (agent: LiveAgent) => void;
    readonly onClose: () => void;
    readonly onRender: () => void;
  };

  constructor(
    agents: () => readonly LiveAgent[],
    selection: LiveAgentStrip,
    theme: AgentTheme,
    options: {
      readonly maxHeight: () => number;
      readonly onOpen: (agent: LiveAgent) => void;
      readonly onClose: () => void;
      readonly onRender: () => void;
    },
  ) {
    this.agents = agents;
    this.selection = selection;
    this.theme = theme;
    this.options = options;
  }

  invalidate(): void {}

  private syncList(maxVisible = 8): SelectList {
    const agents = this.agents();
    const list = new SelectList(
      agents.map((agent) => ({
        value: agent.seat.seatId,
        label: clean(agent.name),
        description: agentMetadata(agent, this.theme),
      })),
      maxVisible,
      { ...this.theme.selectListTheme, description: (text) => text },
      { minPrimaryColumnWidth: 16, maxPrimaryColumnWidth: 44 },
    );
    const selectedId = this.selection.selected()?.seat.seatId;
    list.setSelectedIndex(agents.findIndex((agent) => agent.seat.seatId === selectedId));
    list.onSelectionChange = ({ value }) => this.selection.select(value);
    list.onCancel = this.options.onClose;
    list.onSelect = ({ value }) => {
      const agent = this.agents().find((item) => item.seat.seatId === value);
      if (agent) this.options.onOpen(agent);
    };
    return list;
  }

  handleInput(data: string): void {
    this.syncList().handleInput(data);
    this.options.onRender();
  }

  render(width: number): string[] {
    const contentWidth = Math.max(1, width - 4);
    const agents = this.agents();
    const selected = this.selection.selected();
    const step = selected && currentStep(selected);
    const details = selected
      ? [
          this.theme.ansi.bold(clean(selected.name)),
          `${agentMetadata(selected, this.theme)} · ${this.theme.ansi.dim(clean(selected.seat.seatId))}`,
          step ?? this.theme.ansi.dim("Step unavailable"),
          ...(selected.seat.harnessBridge?.remediation && bridgeWarning(selected, this.theme)
            ? [`${this.theme.ansi.red("Fix:")} ${clean(selected.seat.harnessBridge.remediation)}`]
            : []),
        ].flatMap((line) => wrapTextWithAnsi(line, contentWidth))
      : [];
    // Reserve chrome and selected detail before allocating the scrolling list.
    const help = wrapTextWithAnsi(this.theme.ansi.dim("↑↓ select · enter open · esc close"), contentWidth);
    const maxVisible = Math.max(1, Math.min(12, this.options.maxHeight() - details.length - help.length - 6));
    const rows =
      agents.length > 0
        ? this.syncList(maxVisible).render(contentWidth)
        : [this.theme.ansi.dim("No agents are seated")];
    return renderClankieOutline(
      [
        this.theme.ansi.bold(`Agents · ${agents.length}`),
        ...help,
        "",
        ...rows,
        ...(details.length ? ["", ...details] : []),
      ],
      width,
      this.theme.ansi.dim,
    );
  }
}
