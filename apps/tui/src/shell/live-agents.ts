import type { WorkerReportSummary } from "@clankie/protocol";
import {
  Key,
  matchesKey,
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
  const catalog = seat.toolCatalog;
  if (catalog && catalog.status !== "matched") return ansi.red(`Clankie tools ${clean(catalog.status)}`);
  const bridge = seat.harnessBridge;
  if (
    bridge?.freshness === "older-than-runtime" ||
    bridge?.operatorBridge?.freshness === "older-than-runtime"
  )
    return ansi.red("seat bridge older than runtime");
  if (!bridge || bridge.status === "live-process" || bridge.status === "unobserved") return undefined;
  return ansi.red(`bridge ${clean(bridge.status)}`);
}

function bridgeRemediation({ seat }: LiveAgent): string | undefined {
  if (seat.toolCatalog && seat.toolCatalog.status !== "matched") return seat.toolCatalog.remediation;
  const bridge = seat.harnessBridge;
  return bridge?.operatorBridge?.freshness === "older-than-runtime"
    ? bridge.operatorBridge.remediation
    : bridge?.remediation;
}

function agentMetadata(agent: LiveAgent, theme: AgentTheme): string {
  const { seat } = agent;
  const harness = clean(seat.harness);
  const paintHarness = harness === "claude" ? theme.ansi.yellow : theme.ansi.blue;
  return [
    paintHarness(harness),
    seat.workerReports?.some(
      (report) => report.state === "pending" || report.state === "uncertain" || report.state === "attempting",
    )
      ? theme.ansi.red(`${seat.status === "done" ? "done, " : ""}report not delivered`)
      : seat.workerReports?.length
        ? theme.ansi.yellow("report unread")
        : statusText(seat.status, clean(seat.status), theme),
    // This Mac is the default; only a seat on another machine names where it is.
    seat.fleet === undefined ? undefined : theme.ansi.dim(clean(seat.machine ?? seat.fleet)),
    bridgeWarning(agent, theme),
  ]
    .filter((part): part is string => part !== undefined)
    .join(theme.ansi.dim(" · "));
}

/** Blocked or broken first, then running, then finished; idle seats only count. */
function attentionRank(agent: LiveAgent, theme: AgentTheme): number {
  if (
    agent.seat.workerReports?.length ||
    agent.seat.status === "blocked" ||
    bridgeWarning(agent, theme) !== undefined
  )
    return 0;
  switch (agent.seat.status) {
    case "working":
      return 1;
    case "done":
      return 2;
    case "idle":
      return 3;
    default:
      return 4;
  }
}

function attentionOrder(agents: readonly LiveAgent[], theme: AgentTheme): LiveAgent[] {
  return agents
    .map((agent, index) => ({
      agent,
      index,
      rank: attentionRank(agent, theme),
    }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ agent }) => agent);
}

/** Collapsed, the dock shows at most this many seats that want attention. */
const COLLAPSED_ROWS = 3;

export type LiveAgentStripInput = "open" | "leave" | "consumed" | "pass";

/**
 * The dock under the prompt. Collapsed it lists the seats that want attention;
 * ↓ from an empty prompt focuses it and it expands in place to the whole
 * fleet. The modal shares its selection, a qualified seat identity, never a row index.
 */
export class LiveAgentStrip implements Component {
  private selectedId: string | undefined;
  private expanded = false;
  private readonly agents: () => readonly LiveAgent[];
  private readonly theme: AgentTheme;
  private readonly maxRows: () => number;
  private readonly reports: () => readonly WorkerReportSummary[];

  constructor(
    agents: () => readonly LiveAgent[],
    theme: AgentTheme,
    options: {
      readonly maxRows?: () => number;
      readonly reports?: () => readonly WorkerReportSummary[];
    } = {},
  ) {
    this.agents = agents;
    this.theme = theme;
    this.maxRows = options.maxRows ?? (() => 12);
    this.reports = options.reports ?? (() => []);
  }

  private ordered(): LiveAgent[] {
    return attentionOrder(this.agents(), this.theme);
  }

  selected(): LiveAgent | undefined {
    const agents = this.ordered();
    const selected = agents.find((agent) => agent.seat.seatId === this.selectedId) ?? agents[0];
    this.selectedId = selected?.seat.seatId;
    return selected;
  }

  select(seatId: string): void {
    this.selectedId = seatId;
  }

  get focused(): boolean {
    return this.expanded;
  }

  /** Expand onto the most urgent seat; false when there is nothing to browse. */
  focus(): boolean {
    const first = this.ordered()[0];
    if (first === undefined) return false;
    this.selectedId = first.seat.seatId;
    this.expanded = true;
    return true;
  }

  blur(): void {
    this.expanded = false;
  }

  /** Keys while expanded. Anything that is not navigation collapses and goes back to the prompt. */
  handleInput(data: string): LiveAgentStripInput {
    const agents = this.ordered();
    const index = agents.findIndex((agent) => agent.seat.seatId === this.selected()?.seat.seatId);
    if (matchesKey(data, Key.up)) {
      if (index <= 0) {
        this.blur();
        return "leave";
      }
      this.selectedId = agents[index - 1]!.seat.seatId;
      return "consumed";
    }
    if (matchesKey(data, Key.down)) {
      if (index >= 0 && index < agents.length - 1) this.selectedId = agents[index + 1]!.seat.seatId;
      return "consumed";
    }
    if (matchesKey(data, Key.enter) || data === "\r") {
      this.blur();
      return agents.length > 0 ? "open" : "leave";
    }
    this.blur();
    return matchesKey(data, Key.escape) ? "leave" : "pass";
  }

  invalidate(): void {}

  private row(agent: LiveAgent, prefix: string): string {
    const step = currentStep(agent);
    return `${prefix}${statusText(agent.seat.status, "●", this.theme)} ${clean(agent.name)} · ${agentMetadata(agent, this.theme)}${step ? ` · ${step}` : ""}`;
  }

  render(width: number): string[] {
    const agents = this.ordered();
    const reports = this.reports();
    const reportRows = [...new Set(reports.map((report) => report.paneId))].slice(0, 3).map((pane) => {
      const pending = reports.some((report) => report.paneId === pane && report.state !== "delivered");
      return this.theme.ansi.yellow(`${clean(pane)} · ${pending ? "report not delivered" : "report unread"}`);
    });
    const reportNotice = reports.length
      ? [
          this.theme.ansi.bold(`Worker reports · ${reports.length} unread`),
          ...reportRows,
          this.theme.ansi.dim("/agents reports --conversation ID · read, then acknowledge"),
        ]
      : [];
    if (agents.length === 0) {
      this.expanded = false;
      return reportNotice.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
    }
    const counts = new Map<LiveAgent["seat"]["status"], number>();
    for (const { seat } of agents) counts.set(seat.status, (counts.get(seat.status) ?? 0) + 1);
    const summary = [...counts].map(([status, count]) =>
      statusText(status, `${count} ${status}`, this.theme),
    );
    const { ansi } = this.theme;
    const fit = (line: string) => truncateToWidth(line, Math.max(1, width), "…");
    if (!this.expanded) {
      const attention = agents.filter((agent) => attentionRank(agent, this.theme) < 3);
      return [
        `${ansi.bold(`Agents · ${agents.length}`)}${ansi.dim(" · ↓ list · ctrl+g")}${ansi.dim(" · ")}${summary.join(ansi.dim(" · "))}`,
        ...attention.slice(0, COLLAPSED_ROWS).map((agent) => this.row(agent, "")),
        ...reportNotice,
      ].map(fit);
    }
    const selected = this.selected();
    const index = Math.max(
      0,
      agents.findIndex((agent) => agent.seat.seatId === selected?.seat.seatId),
    );
    const visible = Math.max(1, Math.min(agents.length, this.maxRows() - 1));
    const first = Math.min(Math.max(0, index - Math.floor(visible / 2)), agents.length - visible);
    const position = visible < agents.length ? ansi.dim(` · ${index + 1}/${agents.length}`) : "";
    return [
      `${ansi.bold(`Agents · ${agents.length}`)}${position}${ansi.dim(" · ↑↓ select · enter open · esc back")}`,
      ...agents
        .slice(first, first + visible)
        .map((agent, offset) =>
          first + offset === index
            ? this.row(agent, ansi.accent("› "))
            : ansi.dim("  ") + this.row(agent, ""),
        ),
    ].map(fit);
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
    const agents = attentionOrder(this.agents(), this.theme);
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
    const catalogDetail =
      selected?.seat.toolCatalog && selected.seat.toolCatalog.status !== "matched"
        ? wrapTextWithAnsi(this.theme.ansi.red(clean(selected.seat.toolCatalog.detail)), contentWidth)
        : [];
    // A whole rejected catalog can name dozens of tools. Keep the fixing
    // action visible; doctor retains the complete missing-tool list.
    const shownCatalogDetail = catalogDetail.slice(0, 3);
    if (catalogDetail.length > 3)
      shownCatalogDetail[2] = `${truncateToWidth(shownCatalogDetail[2]!, Math.max(1, contentWidth - 1))}…`;
    const details = selected
      ? [
          this.theme.ansi.bold(clean(selected.name)),
          `${agentMetadata(selected, this.theme)} · ${this.theme.ansi.dim(clean(selected.seat.seatId))}`,
          step ?? this.theme.ansi.dim("Step unavailable"),
          ...shownCatalogDetail,
          ...(bridgeRemediation(selected) && bridgeWarning(selected, this.theme)
            ? [`${this.theme.ansi.red("Fix:")} ${clean(bridgeRemediation(selected)!)}`]
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

/** The tint that marks an agent's conversation: its harness color, or the accent when it is not seated. */
export function agentTint(agent: LiveAgent | undefined, { ansi }: AgentTheme): (text: string) => string {
  if (agent === undefined) return ansi.accent;
  return clean(agent.seat.harness) === "claude" ? ansi.yellow : ansi.blue;
}

/**
 * The fixed bar above the transcript naming the conversation on screen. In an
 * agent's conversation it takes that agent's tint and says how to get home.
 */
export class ConversationHeader implements Component {
  private readonly theme: AgentTheme;
  private readonly view: () => {
    readonly title?: string;
    readonly agent?: { readonly name: string; readonly live?: LiveAgent };
  };

  constructor(
    theme: AgentTheme,
    view: () => {
      readonly title?: string;
      readonly agent?: { readonly name: string; readonly live?: LiveAgent };
    },
  ) {
    this.theme = theme;
    this.view = view;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const { ansi } = this.theme;
    const { title, agent } = this.view();
    const fit = (line: string) => truncateToWidth(line, Math.max(1, width), "…");
    if (agent === undefined) {
      const heading = `${ansi.bold("Clankie")}${title && title !== "Clankie" ? ansi.dim(` · ${clean(title)}`) : ""}`;
      return [fit(heading), ansi.dim("─".repeat(Math.max(1, width)))];
    }
    const tint = agentTint(agent.live, this.theme);
    const details = agent.live === undefined ? "" : ` · ${agentMetadata(agent.live, this.theme)}`;
    return [
      fit(
        `${tint("◀ esc")} ${ansi.dim("Clankie ›")} ${ansi.bold(tint(clean(agent.name)))}${details}${ansi.dim(" · ctrl+y pane")}`,
      ),
      tint("━".repeat(Math.max(1, width))),
    ];
  }
}
