/**
 * The `/usage` panel (VUH-2021): every Claude and Codex account on this Mac
 * with a bar per limit window, a marker where the current pace lands it at
 * reset, a countdown to that reset, how old the reading is, and where the
 * next hire goes. It renders one `GET /v1/usage` report; the overlay re-reads
 * it while open. Wide terminals get one labelled row per window, narrow ones
 * a compact row; color only reinforces what the text already says.
 */
import {
  CURSOR_MARKER,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";
import {
  USAGE_WORDING,
  usagePlanLabel,
  usageWindowPace,
  type UsageAccount,
  type UsageReport,
  type UsageWindow,
} from "@clankie/protocol/worker-accounts";
import type { ClankieCommandUiTheme } from "./clankie-command-ui.ts";
import { renderClankieOutline } from "./clankie-outline.ts";
import { usageResetLocal } from "../command/usage.ts";

export interface UsagePanelOptions {
  readonly theme: ClankieCommandUiTheme;
  readonly unicode: boolean;
  /** When this panel is drawn; countdowns and ages count from here. */
  readonly now: number;
  /** When the report arrived; its ages grow from there. Defaults to `now`. */
  readonly fetchedAt?: number;
  readonly timeZone?: string;
}

/** Below this inner width each window takes the compact row. */
const USAGE_PANEL_WIDE = 96;
/** A reading this old is called out, as `clankie usage` does. */
const STALE_SECONDS = 600;

interface Glyphs {
  readonly full: string;
  readonly empty: string;
  readonly marker: string;
  readonly over: string;
  readonly next: string;
}
const UNICODE: Glyphs = { full: "█", empty: "░", marker: "│", over: "▶", next: "●" };
const ASCII: Glyphs = { full: "#", empty: "-", marker: "|", over: ">", next: "*" };

/** `2h 14m`, `4d 9h`, `12m`, `<1m`. */
function usageCountdown(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `${Math.floor(hours / 24)}d${hours % 24 ? ` ${hours % 24}h` : ""}`;
}

function age(seconds: number): string {
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  return usageCountdown(seconds * 1000);
}

/** The window as the owner says it: `5-hour`, `week`, `30-day`, `Fable week`. */
function windowName(window: UsageWindow, compact: boolean): string {
  if (window.id.includes(":")) {
    const model = /\((.+)\)$/u.exec(window.label)?.[1] ?? window.id.split(":")[1]!;
    return compact ? model.slice(0, 6) : `${model} week`;
  }
  const minutes = window.windowMinutes;
  if (minutes === undefined) return window.id === "week" ? (compact ? "wk" : "week") : window.id;
  if (minutes === 10_080) return compact ? "wk" : "week";
  if (minutes < 1440) return compact ? `${minutes / 60}h` : `${minutes / 60}-hour`;
  return compact ? `${Math.round(minutes / 1440)}d` : `${Math.round(minutes / 1440)}-day`;
}

/** The account's own name: its signed-in identity's local part, else its label. */
function accountName(account: UsageAccount): string {
  return account.identity?.split("@")[0] ?? account.label;
}

interface WindowView {
  readonly name: string;
  readonly used: number;
  /** Percent used at reset if the pace holds; undefined until the pace is known. */
  readonly landing?: number;
  /** When it runs out at that pace, if before its reset. */
  readonly runsOutAt?: number;
  readonly resetsAt?: number;
}

function windowViews(
  report: UsageReport,
  account: UsageAccount,
  compact: boolean,
): { general: WindowView[]; scoped: WindowView[] } {
  const usage = account.usage!;
  // The allocator paced every window at the moment it answered, so draw it at that moment too.
  const pacedAt = Date.parse(usage.observedAt) + (account.ageSeconds ?? 0) * 1000;
  const allocated = report.allocation?.accounts.find(
    (entry) => entry.harness === account.harness && entry.label === account.label,
  );
  const views = usage.windows.map((window): WindowView => {
    const pace = usageWindowPace(window, pacedAt);
    const out = allocated?.runsOut?.find((entry) => entry.window === window.id);
    const runsOutAt = out === undefined ? pace.runsOutAt : Date.parse(out.at);
    return {
      name: windowName(window, compact),
      used: window.usedPercent,
      ...(pace.burnPerDay === undefined
        ? {}
        : { landing: window.usedPercent + pace.burnPerDay * pace.daysToReset }),
      ...(runsOutAt === undefined ? {} : { runsOutAt }),
      ...(window.resetsAt === undefined ? {} : { resetsAt: Date.parse(window.resetsAt) }),
    };
  });
  // The short window first, then the week, as each harness lists them.
  const general = usage.windows
    .map((window, index) => ({ window, view: views[index]! }))
    .filter((entry) => !entry.window.id.includes(":"))
    .sort((a, b) => Number(b.window.id === "session") - Number(a.window.id === "session"))
    .map((entry) => entry.view);
  const scoped = views.filter((_, index) => usage.windows[index]!.id.includes(":"));
  return { general, scoped };
}

function usedTone(theme: ClankieCommandUiTheme, percent: number): (text: string) => string {
  return percent >= 85 ? theme.red : percent >= 60 ? theme.yellow : theme.green;
}

function bar(view: WindowView, width: number, glyphs: Glyphs, theme: ClankieCommandUiTheme): string {
  const filled = Math.max(0, Math.min(width, Math.round((view.used / 100) * width)));
  const fill = usedTone(theme, view.used);
  const cells = Array.from({ length: width }, (_, index) =>
    index < filled ? { glyph: glyphs.full, tone: fill } : { glyph: glyphs.empty, tone: theme.dim },
  );
  if (view.landing !== undefined) {
    const out = view.runsOutAt !== undefined || view.landing >= 100;
    const at = out ? width - 1 : Math.min(width - 1, Math.floor((view.landing / 100) * width));
    // A marker inside the fill, or at a pace that adds nothing, says nothing new.
    if (out || (at >= filled && view.landing - view.used >= 1))
      cells[at] = out ? { glyph: glyphs.over, tone: theme.red } : { glyph: glyphs.marker, tone: theme.cyan };
  }
  // One escape per run of a tone, not per cell.
  let text = "";
  for (let start = 0; start < cells.length;) {
    let end = start;
    while (end < cells.length && cells[end]!.tone === cells[start]!.tone) end += 1;
    text += cells[start]!.tone(
      cells
        .slice(start, end)
        .map((cell) => cell.glyph)
        .join(""),
    );
    start = end;
  }
  return text;
}

function paceText(
  view: WindowView,
  theme: ClankieCommandUiTheme,
  compact: boolean,
  now: number,
  timeZone: string | undefined,
): string {
  if (view.runsOutAt !== undefined)
    return theme.red(
      `${compact ? "out" : "runs out"} ~${usageResetLocal(new Date(view.runsOutAt).toISOString(), now, timeZone)}`,
    );
  if (view.landing === undefined) return theme.dim(compact ? "" : "pace not known yet");
  const landing = `${Math.round(Math.min(100, view.landing))}%`;
  return theme.dim(compact ? `→${landing}` : `→ ${landing} at reset`);
}

function resetText(view: WindowView, theme: ClankieCommandUiTheme, compact: boolean, now: number): string {
  if (view.resetsAt === undefined) return theme.dim(compact ? "?" : "reset unknown");
  const countdown = usageCountdown(view.resetsAt - now);
  return theme.dim(compact ? countdown.replace(" ", "") : `resets in ${countdown}`);
}

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** The panel's lines at an inner width, without its frame. */
function renderUsagePanel(report: UsageReport, width: number, options: UsagePanelOptions): string[] {
  const { theme, now } = options;
  const glyphs = options.unicode ? UNICODE : ASCII;
  const compact = width < USAGE_PANEL_WIDE;
  const fetchedAt = options.fetchedAt ?? now;
  const next = new Map(
    (report.allocation?.recommendations ?? [])
      .filter((entry) => entry.label !== undefined)
      .map((entry) => [`${entry.harness}:${entry.label}`, true]),
  );
  const lines: string[] = [];
  const blocks = report.accounts.map((account) => ({
    account,
    views: account.usage === undefined ? undefined : windowViews(report, account, compact),
  }));
  const nameWidth = Math.max(
    ...blocks.flatMap((block) =>
      block.views === undefined
        ? []
        : [...block.views.general, ...block.views.scoped].map((view) => view.name.length),
    ),
    compact ? 2 : 6,
  );
  for (const [index, { account, views }] of blocks.entries()) {
    if (index > 0 && !compact) lines.push("");
    const harness = account.harness === "claude" ? "Claude" : "Codex";
    const plan = usagePlanLabel(account);
    const title = `${theme.bold(`${harness} ${accountName(account)}`)}${plan ? theme.dim(` · ${plan}`) : ""}`;
    const notes: string[] = [];
    if (next.has(`${account.harness}:${account.label}`))
      notes.push(theme.cyan(`${glyphs.next} ${compact ? "next" : "next hire"}`));
    if (account.held)
      notes.push(
        theme.yellow(compact ? "held" : `held${account.held.reason ? `: ${account.held.reason}` : ""}`),
      );
    else if (account.signedIn === false) notes.push(theme.red("not signed in"));
    if (account.ageSeconds !== undefined) {
      const seconds = account.ageSeconds + Math.max(0, now - fetchedAt) / 1000;
      const text = compact ? age(seconds) : `read ${age(seconds)} ago`;
      notes.push(seconds >= STALE_SECONDS ? theme.yellow(text) : theme.dim(text));
    }
    const right = notes.join(theme.dim(" · "));
    const gap = width - visibleWidth(title) - visibleWidth(right);
    lines.push(gap >= 2 ? `${title}${" ".repeat(gap)}${right}` : `${title}  ${right}`);
    if (views === undefined) {
      const reason =
        account.signedIn === false
          ? (account.reason ?? "").replace(/^not signed in\.\s*/u, "")
          : (account.reason ?? USAGE_WORDING.unknown);
      if (reason) lines.push(`  ${theme.dim(reason)}`);
      continue;
    }
    for (const view of [...views.general, ...views.scoped]) {
      const percent = usedTone(theme, view.used)(`${String(Math.round(view.used)).padStart(3)}%`);
      const pace = paceText(view, theme, compact, now, options.timeZone);
      const reset = resetText(view, theme, compact, now);
      const label = theme.dim(view.name.padEnd(nameWidth));
      if (compact) {
        // label bar pct pace reset: the bar takes what the text leaves.
        const tail = ` ${pace ? pad(pace, 15) : " ".repeat(15)} ${reset}`;
        const barWidth = Math.max(6, Math.min(24, width - 2 - nameWidth - 1 - 1 - 4 - visibleWidth(tail)));
        lines.push(`  ${label} ${bar(view, barWidth, glyphs, theme)} ${percent}${tail}`);
      } else {
        const barWidth = Math.max(16, Math.min(48, width - 2 - nameWidth - 2 - 2 - 4 - 2 - 26 - 2 - 18));
        lines.push(
          `  ${label}  ${bar(view, barWidth, glyphs, theme)}  ${percent}  ${pad(pace, 26)}  ${reset}`,
        );
      }
    }
  }
  for (const [harness, reason] of Object.entries(report.unavailable ?? {}))
    lines.push(theme.yellow(`${harness === "claude" ? "Claude" : "Codex"} unavailable: ${reason}`));
  const recommendations = report.allocation?.recommendations ?? [];
  if (recommendations.length) lines.push("");
  for (const entry of recommendations) {
    // The allocator's line names the pick; its "Meanwhile" tail is already on the bars above.
    const reason = entry.reason.replace(/\. Meanwhile .*$/su, "");
    const match = /^next (Claude|Codex) hire → (.*)$/su.exec(reason);
    // The allocator names accounts by label; the rows above go by who is signed in.
    const picked = report.accounts.find(
      (account) => account.harness === entry.harness && account.label === entry.label,
    );
    if (match && picked && entry.label !== undefined && match[2]!.startsWith(`${entry.label} `))
      match[2] = `${accountName(picked)}${match[2]!.slice(entry.label.length)}`;
    const line = match
      ? `${theme.cyan(`${USAGE_WORDING.nextHire} ${match[1]} →`)} ${match[2]}`
      : theme.yellow(reason);
    lines.push(...wrapTextWithAnsi(line, width - 2).map((part, index) => (index ? `  ${part}` : part)));
  }
  const warning = report.settings.allocation;
  lines.push(
    theme.dim(
      `Overlay ${report.settings.display.overlay ? "shown" : "hidden"}${
        warning === undefined
          ? ""
          : warning.runOutWarning
            ? ` · run-out warning ${warning.runOutWarningHours}h`
            : " · run-out warning off"
      }`,
    ),
  );
  return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
}

export interface UsagePanelSource {
  /** One report; `refresh` asks every harness again instead of the shared minute-old read. */
  read(refresh: boolean): Promise<UsageReport>;
  setOverlay(on: boolean, revision: string): Promise<void>;
  setRunOutWarning(on: boolean, revision: string): Promise<void>;
}

/** How often an open panel re-reads; the service shares a reading for a minute. */
const POLL_MS = 15_000;
/** Countdowns and ages tick between reads. */
const TICK_MS = 1_000;

/** The live overlay: re-reads while open, `r` reads fresh, `o`/`w` flip the two settings. */
export class ClankieUsageOverlay implements Component, Focusable {
  focused = false;
  private report: UsageReport | undefined;
  private fetchedAt = 0;
  private notice: string | undefined;
  /** What a fresh read is doing, shown while it runs. */
  private status: string | undefined;
  private busy = false;
  private refreshQueued = false;
  private readonly timers: ReturnType<typeof setInterval>[] = [];

  private readonly source: UsagePanelSource;
  private readonly callbacks: { readonly onClose: () => void; readonly onRender: () => void };
  private readonly options: Omit<UsagePanelOptions, "now" | "fetchedAt"> & { readonly clock?: () => number };
  private readonly theme: ClankieCommandUiTheme;
  private readonly clock: () => number;

  constructor(
    source: UsagePanelSource,
    callbacks: { readonly onClose: () => void; readonly onRender: () => void },
    options: Omit<UsagePanelOptions, "now" | "fetchedAt"> & { readonly clock?: () => number },
  ) {
    this.source = source;
    this.callbacks = callbacks;
    this.options = options;
    this.theme = options.theme;
    this.clock = options.clock ?? Date.now;
  }

  /** Starts reading; `refresh` makes the first read a fresh one. */
  start(refresh: boolean): void {
    void this.load(refresh);
    this.timers.push(setInterval(() => void this.load(false), POLL_MS));
    this.timers.push(setInterval(() => this.callbacks.onRender(), TICK_MS));
    for (const timer of this.timers) timer.unref?.();
  }

  stop(): void {
    for (const timer of this.timers.splice(0)) clearInterval(timer);
  }

  invalidate(): void {}

  setReport(report: UsageReport, fetchedAt = this.clock()): void {
    this.report = report;
    this.fetchedAt = fetchedAt;
    this.notice = undefined;
    this.callbacks.onRender();
  }

  private async load(refresh: boolean): Promise<void> {
    if (this.busy) {
      // A fresh read asked for mid-poll runs right after it rather than being lost.
      this.refreshQueued ||= refresh;
      return;
    }
    this.busy = true;
    if (refresh) this.setNotice(undefined, "reading every account…");
    try {
      this.setReport(await this.source.read(refresh));
    } catch (error) {
      this.setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy = false;
      this.callbacks.onRender();
    }
    if (this.refreshQueued) {
      this.refreshQueued = false;
      await this.load(true);
    }
  }

  private setNotice(error: string | undefined, status?: string): void {
    this.notice = error;
    this.status = status;
    this.callbacks.onRender();
  }

  private async toggle(setting: "overlay" | "warning"): Promise<void> {
    const report = this.report;
    if (report === undefined || this.busy) return;
    try {
      if (setting === "overlay")
        await this.source.setOverlay(!report.settings.display.overlay, report.settings.revision);
      else if (report.settings.allocation !== undefined)
        await this.source.setRunOutWarning(
          !report.settings.allocation.runOutWarning,
          report.settings.revision,
        );
      await this.load(false);
    } catch (error) {
      this.setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") {
      this.callbacks.onClose();
      return;
    }
    if (data === "r") void this.load(true);
    if (data === "o") void this.toggle("overlay");
    if (data === "w") void this.toggle("warning");
  }

  render(width: number): string[] {
    const renderWidth = Math.max(24, width);
    const inner = Math.max(20, renderWidth - 4);
    const now = this.clock();
    const keys = inner < USAGE_PANEL_WIDE ? "r o w · esc" : "r refresh · o overlay · w warning · esc close";
    const cursor = this.focused ? CURSOR_MARKER : "";
    const header = `${this.theme.bold(USAGE_WORDING.title)}${this.report ? this.theme.dim(` · ${this.report.machine}`) : ""}`;
    const right = this.theme.dim(keys);
    const gap = inner - visibleWidth(header) - visibleWidth(right);
    const status =
      this.notice !== undefined
        ? this.theme.red(this.notice)
        : this.status !== undefined && this.busy
          ? this.theme.dim(this.status)
          : this.report === undefined
            ? this.theme.dim("reading…")
            : this.theme.dim(`live · updated ${age((now - this.fetchedAt) / 1000)} ago`);
    const body =
      this.report === undefined
        ? []
        : renderUsagePanel(this.report, inner, {
            theme: this.theme,
            unicode: this.options.unicode,
            ...(this.options.timeZone === undefined ? {} : { timeZone: this.options.timeZone }),
            now,
            fetchedAt: this.fetchedAt,
          });
    return renderClankieOutline(
      [`${header}${" ".repeat(Math.max(2, gap))}${right}${cursor}`, status, "", ...body],
      renderWidth,
      this.theme.dim,
    );
  }
}
