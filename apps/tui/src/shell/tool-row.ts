/**
 * One tool call, one row: a status mark, the tool's name and its main
 * argument. Hovering or selecting the row brightens it; clicking it, or Enter
 * on a selected row, opens the original Pi tool component beneath it with the
 * full call and output. Failed calls keep their first error line visible while
 * closed.
 */
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { ClankieFaceAnsiTheme } from "../face/clankie-face-theme.ts";
import { ClankieRenderCache } from "../face/clankie-render-cache.ts";
import { summarizeToolArgs } from "./tool-render.ts";

/** The argument that says what a call did, in the order a reader looks for it. */
const PRIMARY_ARGS = ["command", "cmd", "pattern", "query", "path", "file_path", "url"] as const;
const SUMMARY_WIDTH = 96;

/** `echo one`, `src/index.ts`, or the generic `key=value` summary. */
function toolRowSummary(args: unknown): string {
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    const record = args as Record<string, unknown>;
    for (const key of PRIMARY_ARGS) {
      const value = record[key];
      const text = typeof value === "string" ? value : Array.isArray(value) ? value.join(" ") : undefined;
      if (text === undefined || text.trim() === "") continue;
      const line = text.replace(/\s+/gu, " ").trim();
      return line.length > SUMMARY_WIDTH ? `${line.slice(0, SUMMARY_WIDTH - 1)}…` : line;
    }
  }
  return summarizeToolArgs(args);
}

export class ClankieToolRow implements Component {
  readonly component: ToolExecutionComponent;
  private readonly name: string;
  private readonly ansi: ClankieFaceAnsiTheme;
  private readonly unicode: boolean;
  private summary: string;
  private state: "running" | "done" | "failed" = "running";
  private errorLine: string | undefined;
  private expanded = false;
  /** What is pointing at the row: the mouse or the keyboard selection. */
  private highlighted: "mouse" | "key" | undefined;
  private readonly cache = new ClankieRenderCache();

  constructor(
    component: ToolExecutionComponent,
    name: string,
    args: unknown,
    options: { readonly ansi: ClankieFaceAnsiTheme; readonly unicode: boolean },
  ) {
    this.component = component;
    this.name = name;
    this.summary = toolRowSummary(args);
    this.ansi = options.ansi;
    this.unicode = options.unicode;
  }

  get isExpanded(): boolean {
    return this.expanded;
  }

  complete(failed: boolean, detail: string | undefined): void {
    this.state = failed ? "failed" : "done";
    this.errorLine = failed
      ? detail
          ?.split("\n")
          .find((line) => line.trim() !== "")
          ?.trim()
      : undefined;
    this.cache.clear();
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.component.setExpanded(expanded);
    this.cache.clear();
  }

  setHighlighted(highlighted: "mouse" | "key" | undefined): void {
    if (highlighted === this.highlighted) return;
    this.highlighted = highlighted;
    this.cache.clear();
  }

  invalidate(): void {
    this.component.invalidate();
    this.cache.clear();
  }

  render(width: number): string[] {
    const head = this.cache.get(width, () => {
      const lines = [truncateToWidth(this.headline(), width, "…")];
      if (!this.expanded && this.errorLine !== undefined) {
        const branch = this.unicode ? "╰" : "`";
        lines.push(truncateToWidth(this.ansi.danger(`   ${branch} ${this.errorLine}`), width, "…"));
      }
      return lines;
    });
    // Open rows delegate to Pi's component, which memoizes its own lines.
    return this.expanded ? [...head, ...this.component.render(width)] : head;
  }

  private headline(): string {
    const { ansi } = this;
    const mark =
      this.state === "failed"
        ? ansi.danger(this.unicode ? "✗" : "x")
        : this.state === "done"
          ? ansi.success(this.unicode ? "✓" : "+")
          : ansi.dim(this.unicode ? "•" : "*");
    const name =
      this.highlighted !== undefined ? ansi.bold(ansi.selectedDescription(this.name)) : ansi.label(this.name);
    const paint = this.highlighted !== undefined ? ansi.label : ansi.dim;
    const detail = [
      ...(this.summary === "" ? [] : [this.summary]),
      ...(this.state === "running" ? ["running"] : []),
      ...(this.state === "failed" ? ["failed"] : []),
    ];
    const action = this.expanded ? "close" : "open";
    const hint =
      this.highlighted === undefined
        ? ""
        : ansi.dim(this.highlighted === "mouse" ? `  click to ${action}` : `  enter to ${action} · esc`);
    return ` ${mark} ${name}${detail.length === 0 ? "" : paint(` · ${detail.join(" · ")}`)}${hint}`;
  }
}
