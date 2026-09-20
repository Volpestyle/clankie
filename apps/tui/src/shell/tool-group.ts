import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { ClankieFaceAnsiTheme } from "../face/clankie-face-theme.ts";
import { ClankieRenderCache } from "../face/clankie-render-cache.ts";
import { summarizeToolArgs } from "./tool-render.ts";

/** Only explicit read-only tools qualify; never infer shell command safety. */
const EXPLORATION_TOOLS = new Map([
  ["read", "Read"],
  ["grep", "Search"],
  ["find", "Find"],
  ["ls", "List"],
]);

export class ClankieToolGroup implements Component {
  private readonly entries: {
    component: ToolExecutionComponent;
    label: string;
    complete: boolean;
    failed: boolean;
  }[] = [];
  sealed = false;
  private expanded = false;
  private readonly cache = new ClankieRenderCache();
  private readonly ansi: ClankieFaceAnsiTheme;

  constructor(ansi: ClankieFaceAnsiTheme) {
    this.ansi = ansi;
  }

  static accepts(name: string): boolean {
    return EXPLORATION_TOOLS.has(name);
  }

  add(component: ToolExecutionComponent, name: string, args: unknown): void {
    this.entries.push({
      component,
      label: `${EXPLORATION_TOOLS.get(name)} ${summarizeToolArgs(args)}`.trim(),
      complete: false,
      failed: false,
    });
    component.setExpanded(this.expanded);
    this.cache.clear();
  }

  complete(component: ToolExecutionComponent, failed: boolean): void {
    const entry = this.entries.find((item) => item.component === component);
    if (entry !== undefined) {
      entry.complete = true;
      entry.failed = failed;
    }
    this.cache.clear();
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    for (const entry of this.entries) entry.component.setExpanded(expanded);
    this.cache.clear();
  }

  invalidate(): void {
    for (const entry of this.entries) entry.component.invalidate();
    this.cache.clear();
  }

  render(width: number): string[] {
    return this.cache.get(width, () => {
      const working = this.entries.some((entry) => !entry.complete);
      const title = `• ${working ? "Exploring" : "Explored"} · ${this.entries.length} ${this.entries.length === 1 ? "operation" : "operations"}`;
      const lines = ["", truncateToWidth(this.ansi.bold(title), width, "")];
      if (this.expanded) {
        for (const entry of this.entries) lines.push(...entry.component.render(width));
      } else {
        for (const [index, entry] of this.entries.slice(-3).entries()) {
          lines.push(
            truncateToWidth(
              this.ansi.dim(
                `  ${index === 0 ? "└" : " "} ${entry.label}${entry.failed ? " · failed" : entry.complete ? "" : " · running"}`,
              ),
              width,
              "…",
            ),
          );
        }
        if (this.entries.length > 3)
          lines.push(
            truncateToWidth(
              this.ansi.dim(`    +${this.entries.length - 3} earlier · click or Ctrl+O to expand`),
              width,
              "…",
            ),
          );
        // Failure diagnostics remain visible even when successful reads are folded.
        for (const entry of this.entries) if (entry.failed) lines.push(...entry.component.render(width));
      }
      return lines;
    });
  }
}
