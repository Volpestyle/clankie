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
    this.head = new Markdown(heading(headline.trim(), body), 1, 0, getMarkdownTheme());
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

/**
 * A Linear event arrives as a generic preamble ("Untrusted Linear event
 * context:") over one quoted JSON line. Name the event from that line so the
 * collapsed row says what happened; anything else keeps its own first line.
 */
function heading(headline: string, body: string): string {
  const source = /^Untrusted (.+) event context:$/u.exec(headline)?.[1];
  if (source === undefined || !body.startsWith("> ")) return `**External activity** ${headline}`;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(body.slice(2).split("\n")[0]!) as Record<string, unknown>;
  } catch {
    return `**External activity** ${headline}`;
  }
  const text = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "");
  const what = text(event.headline).replace(new RegExp(`^${source}\\s+`, "u"), "");
  const line = [text(event.identifier), what].filter((part) => part.length > 0).join(" · ");
  return line.length > 0 ? `**${source}** ${line}` : `**External activity** ${source} event`;
}
