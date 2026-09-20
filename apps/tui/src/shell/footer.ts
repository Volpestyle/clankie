/**
 * A quiet working-context line with model and context remaining on the right.
 * Narrow terminals put the stats on a second row; exceptional status gets its own row. Data flows in through a provider so the
 * footer always renders current state without change bookkeeping.
 */
import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { HerdrBinding, OperatorConversationContextUsage } from "@clankie/protocol";
import type { ClankieFaceAnsiTheme } from "../face/clankie-face-theme.ts";
import type { PresenceSnapshot } from "../observation/presence.ts";

export interface ClankieFooterData {
  readonly model?: string | undefined;
  readonly title?: string | undefined;
  readonly contextUsage?: OperatorConversationContextUsage | undefined;
}

export interface ClankieFooterState extends ClankieFooterData {
  readonly cwd: string;
  readonly extras: readonly string[];
}

/** Which fleet he leads right now: his own, or a named session of the owner's. */
export function describeHerdrBinding(binding: HerdrBinding): string {
  return binding.runtime === "bundled" ? "Clankie’s own session" : binding.session;
}

export function formatCaptainPresenceStatus(presence: PresenceSnapshot | undefined): string {
  return `discord ${presence?.phase.replaceAll("_", " ") ?? "unavailable"}`;
}

/** Human context readout for `/status`: `72.4k / 200k`. */
export function formatCaptainContextUsage(usage: OperatorConversationContextUsage | undefined): string {
  if (usage === undefined) return "unavailable";
  return `${usage.tokens === null ? "?" : formatTokenCount(usage.tokens)} / ${formatTokenCount(usage.contextWindow)}`;
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  const divisor = tokens < 1_000_000 ? 1_000 : 1_000_000;
  const suffix = divisor === 1_000 ? "k" : "m";
  const value = tokens / divisor;
  return `${value >= 100 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}${suffix}`;
}

/** pi's compact token formatting (999, 1.2k, 200k, 1.2M). */
export function formatFooterTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

export type FooterContextLevel = "ok" | "warning" | "error";

/** Context remaining, escalating color past 70% and 90% usage. */
export function formatFooterContext(usage: OperatorConversationContextUsage | undefined): {
  readonly text: string;
  readonly level: FooterContextLevel;
} {
  if (usage === undefined) return { level: "ok", text: "context ?" };
  const window = formatFooterTokens(usage.contextWindow);
  if (usage.tokens === null) return { level: "ok", text: `?/${window}` };
  const percent = usage.contextWindow > 0 ? (usage.tokens / usage.contextWindow) * 100 : 0;
  return {
    level: percent > 90 ? "error" : percent > 70 ? "warning" : "ok",
    text: `${Math.max(0, 100 - percent).toFixed(0)}% context left`,
  };
}

export function displayHomePath(path: string): string {
  const home = process.env.HOME;
  if (home !== undefined && home.length > 0 && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

export class ClankieFooterComponent implements Component {
  private readonly ansi: ClankieFaceAnsiTheme;
  private readonly state: () => ClankieFooterState;

  constructor(ansi: ClankieFaceAnsiTheme, state: () => ClankieFooterState) {
    this.ansi = ansi;
    this.state = state;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const { ansi } = this;
    const state = this.state();
    const safeWidth = Math.max(1, width);
    const contextLine = [displayHomePath(state.cwd), ...(state.title === undefined ? [] : [state.title])]
      .filter((part) => part.length > 0)
      .join(" • ");
    const stats = this.renderStatsLine(state, safeWidth);
    const padding = safeWidth - visibleWidth(contextLine) - visibleWidth(stats);
    const lines =
      padding >= 2
        ? [ansi.dim(contextLine) + " ".repeat(padding) + stats]
        : [truncateToWidth(ansi.dim(contextLine), safeWidth, ansi.dim("…")), stats];
    const extras = state.extras.filter((part) => part.length > 0);
    if (extras.length > 0) {
      const joined = extras
        .map((part) => (part.includes("\x1b[") ? part : ansi.dim(part)))
        .join(ansi.dim(" · "));
      lines.push(truncateToWidth(joined, safeWidth, ansi.dim("...")));
    }
    return lines;
  }

  /** Keep the context readout visible when a long model name needs truncation. */
  private renderStatsLine(state: ClankieFooterState, width: number): string {
    const { ansi } = this;
    const usage = formatFooterContext(state.contextUsage);
    const statsLeft =
      usage.level === "error"
        ? ansi.red(usage.text)
        : usage.level === "warning"
          ? ansi.yellow(usage.text)
          : ansi.dim(usage.text);
    const statsLeftWidth = visibleWidth(statsLeft);
    if (statsLeftWidth > width) return truncateToWidth(statsLeft, width, "...");
    const minPadding = 2;
    const rightSide = state.model ?? "";
    const availableForRight = width - statsLeftWidth - minPadding;
    if (rightSide.length === 0 || availableForRight <= 0) return statsLeft;
    const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
    return `${ansi.dim(truncatedRight)}  ${statsLeft}`;
  }
}
