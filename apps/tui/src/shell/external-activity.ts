/**
 * Transcript block for received external context (a Linear event): the
 * headline stays visible, the quoted payload unfolds on click or Ctrl+O like a
 * tool result. Hundreds of events then read as a list, not a wall.
 */
import { Markdown, type Component } from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";

export class ClankieExternalActivityComponent implements Component {
  private readonly head: Markdown;
  private readonly body: Markdown | undefined;
  private expanded = false;

  constructor(text: string) {
    const [headline = "", ...rest] = text.split("\n");
    const body = rest.join("\n").trim();
    this.head = new Markdown(`**External activity** ${headline.trim()}`, 1, 0, getMarkdownTheme());
    this.body = body.length === 0 ? undefined : new Markdown(body, 1, 0, getMarkdownTheme());
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  invalidate(): void {
    this.head.invalidate();
    this.body?.invalidate();
  }

  render(width: number): string[] {
    const lines = this.head.render(width);
    return this.expanded && this.body !== undefined ? [...lines, ...this.body.render(width)] : lines;
  }
}
