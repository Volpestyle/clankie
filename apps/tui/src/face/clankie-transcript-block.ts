import { Markdown, truncateToWidth, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";

export type ClankieTranscriptBlockTheme = {
  readonly bold: (text: string) => string;
  readonly cyan: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly green: (text: string) => string;
  readonly loadingGlyph: () => string;
  readonly red: (text: string) => string;
  readonly yellow: (text: string) => string;
  readonly markdown: MarkdownTheme;
};

export type ParsedTranscriptMarkdown = {
  readonly body: string;
  readonly title: string;
  readonly tone: TranscriptBlockTone;
};

type TranscriptBlockTone =
  | "assistant"
  | "auth"
  | "command"
  | "error"
  | "notice"
  | "question"
  | "reasoning"
  | "skill"
  | "subagent"
  | "system"
  | "tool"
  | "user"
  | "warning";

export class ClankieTranscriptMarkdownBlock implements Component {
  private markdown: string;
  private readonly theme: ClankieTranscriptBlockTheme;
  private bodyRenderer: Markdown | undefined;
  private bodyRendererText = "";

  constructor(markdown: string, theme: ClankieTranscriptBlockTheme) {
    this.markdown = markdown;
    this.theme = theme;
  }

  setMarkdown(markdown: string): void {
    this.markdown = markdown;
    if (this.bodyRenderer !== undefined) {
      const parsed = parseTranscriptMarkdown(markdown);
      this.bodyRendererText = parsed.body;
      this.bodyRenderer.setText(parsed.body);
    }
  }

  invalidate(): void {
    this.bodyRenderer?.invalidate();
  }

  render(width: number): string[] {
    const parsed = parseTranscriptMarkdown(this.markdown);
    const bodyPrefix = bodyLinePrefix(parsed.tone);
    const contentWidth = Math.max(1, width - bodyPrefix.length);
    const header = this.renderHeader(parsed, width);
    const bodyLines = this.renderBody(parsed.body, contentWidth);
    return [
      header,
      ...bodyLines.map((line) => `${bodyPrefix}${truncateToWidth(line, contentWidth, "", true)}`),
    ];
  }

  private renderHeader(parsed: ParsedTranscriptMarkdown, width: number): string {
    const title = renderTitle(parsed.title, parsed.tone, this.theme);
    return truncateToWidth(title, width, "", true);
  }

  private renderBody(body: string, width: number): string[] {
    if (body.trim().length === 0) return [];
    if (this.bodyRenderer === undefined || this.bodyRendererText !== body) {
      this.bodyRenderer = new Markdown(body, 0, 0, this.theme.markdown);
      this.bodyRendererText = body;
    }
    return this.bodyRenderer.render(width);
  }
}

export function parseTranscriptMarkdown(markdown: string): ParsedTranscriptMarkdown {
  const normalized = markdown.trimEnd();
  const lines = normalized.split(/\r?\n/u);
  const first = lines[0]?.trim() ?? "";
  const titleMatch = /^\*\*(.+)\*\*$/u.exec(first);
  if (titleMatch === null) {
    return { body: normalized, title: "Transcript", tone: "system" };
  }

  let bodyStart = 1;
  while (bodyStart < lines.length && (lines[bodyStart] ?? "").trim().length === 0) bodyStart += 1;
  const title = titleMatch[1] ?? "Transcript";
  return {
    body: lines.slice(bodyStart).join("\n").trimEnd(),
    title,
    tone: toneForTitle(title),
  };
}

function renderTitle(title: string, tone: TranscriptBlockTone, theme: ClankieTranscriptBlockTheme): string {
  const skill = /^Skill: (.+?) - (.+)$/u.exec(title);
  if (skill !== null) {
    const name = skill[1] ?? "skill";
    const status = skill[2] ?? "";
    const label = status.toLowerCase() === "running" ? "loading skill" : "skill";
    return `${skillStatusGlyph(status, theme)} ${theme.bold(name)} ${theme.yellow(label)} ${theme.dim(status)}`;
  }
  const tool = /^Tool: (.+?) - (.+)$/u.exec(title);
  if (tool !== null) {
    const name = tool[1] ?? "tool";
    const status = tool[2] ?? "";
    return `${toolStatusGlyph(status, theme)} ${theme.bold(name)} ${theme.dim(status)}`;
  }
  const subagent = /^Subagent: (.+?) - (.+)$/u.exec(title);
  if (subagent !== null) {
    const name = subagent[1] ?? "subagent";
    const status = subagent[2] ?? "";
    return `${subagentStatusGlyph(status, theme)} ${theme.bold(name)} ${theme.dim("subagent")} ${theme.dim(status)}`;
  }
  const subagentFailed = /^Subagent failed: (.+)$/u.exec(title);
  if (subagentFailed !== null) {
    const name = subagentFailed[1] ?? "subagent";
    return `${theme.red("◆")} ${theme.bold(name)} ${theme.dim("subagent")} ${theme.dim("failed")}`;
  }
  const subagentTool = /^Subagent tool: (.+?) \/ (.+?) - (.+)$/u.exec(title);
  if (subagentTool !== null) {
    const name = subagentTool[1] ?? "subagent";
    const toolName = subagentTool[2] ?? "tool";
    const status = subagentTool[3] ?? "";
    return `│ ${toolStatusGlyph(status, theme)} ${theme.bold(toolName)} ${theme.dim(name)} ${theme.dim(status)}`;
  }
  const subagentStep = /^Subagent (step|reasoning): (.+)$/u.exec(title);
  if (subagentStep !== null) {
    const kind = subagentStep[1] ?? "step";
    const name = subagentStep[2] ?? "subagent";
    return `│ ${kind === "reasoning" ? theme.yellow("○") : theme.cyan("▲")} ${theme.bold(name)} ${theme.dim(kind)}`;
  }
  const auth = /^Authorization(?: (.+))?$/u.exec(title);
  if (auth !== null)
    return `${theme.cyan("●")} ${theme.bold("Auth")}${auth[1] === undefined ? "" : ` ${theme.dim(auth[1])}`}`;
  const input = /^Input(?: (.+))?$/u.exec(title);
  if (input !== null)
    return `${theme.cyan("?")} ${theme.bold("Input")}${input[1] === undefined ? "" : ` ${theme.dim(input[1])}`}`;

  const prefix = titlePrefix(title, tone);
  const styledPrefix = stylePrefix(prefix, tone, theme);
  const remainder = title === prefix || prefix.endsWith(` ${title}`) ? "" : ` ${theme.bold(title)}`;
  return `${styledPrefix}${remainder}`;
}

function titlePrefix(title: string, tone: TranscriptBlockTone): string {
  if (tone === "assistant") return "▲ Clankie";
  if (tone === "auth") return "● Auth";
  if (tone === "command") return "⎿ Command";
  if (tone === "user") return "▌ You";
  if (tone === "reasoning") return "○ Reasoning";
  if (tone === "notice") return "· Notice";
  if (tone === "question") return "? Input";
  if (tone === "skill") return "✦ Skill";
  if (tone === "subagent") return "◆ Subagent";
  if (tone === "tool") return "● Tool";
  if (tone === "error") return "⨯ Error";
  if (tone === "warning") return "⚠ Warning";
  return title;
}

function toolStatusGlyph(status: string, theme: ClankieTranscriptBlockTheme): string {
  const normalized = status.toLowerCase();
  if (
    normalized === "approved" ||
    normalized === "authorized" ||
    normalized === "completed" ||
    normalized === "done"
  )
    return theme.green("✓");
  if (normalized === "failed" || normalized === "error") return theme.red("⨯");
  if (
    normalized === "approval requested" ||
    normalized === "pending" ||
    normalized === "rejected" ||
    normalized === "denied"
  )
    return theme.yellow("–");
  return theme.cyan(theme.loadingGlyph());
}

function stylePrefix(prefix: string, tone: TranscriptBlockTone, theme: ClankieTranscriptBlockTheme): string {
  switch (tone) {
    case "assistant":
      return theme.cyan(prefix);
    case "auth":
      return theme.cyan(prefix);
    case "command":
      return theme.dim(prefix);
    case "error":
      return theme.red(prefix);
    case "notice":
      return theme.dim(prefix);
    case "question":
      return theme.cyan(prefix);
    case "reasoning":
      return theme.yellow(prefix);
    case "skill":
      return theme.yellow(prefix);
    case "subagent":
      return theme.cyan(prefix);
    case "tool":
      return theme.cyan(prefix);
    case "user":
      return theme.green(prefix);
    case "warning":
      return theme.yellow(prefix);
    case "system":
      return theme.dim(prefix);
  }
}

function toneForTitle(title: string): TranscriptBlockTone {
  const normalized = title.toLowerCase();
  // "clanky" is the agent's pre-rename author label, still present in old transcripts.
  if (normalized === "clankie" || normalized === "clanky" || normalized === "assistant") return "assistant";
  if (normalized === "you" || normalized === "user") return "user";
  if (normalized.startsWith("authorization")) return "auth";
  if (normalized.startsWith("command")) return "command";
  if (normalized.startsWith("input")) return "question";
  if (normalized.startsWith("notice")) return "notice";
  if (normalized.startsWith("skill:")) return "skill";
  if (normalized.startsWith("subagent")) return "subagent";
  if (normalized.startsWith("tool:") || normalized.includes("tool")) return "tool";
  if (normalized.includes("reasoning")) return "reasoning";
  if (normalized.includes("error") || normalized.includes("failed") || normalized.includes("failure"))
    return "error";
  if (normalized.includes("warning") || normalized.includes("cancelled")) return "warning";
  return "system";
}

function bodyLinePrefix(tone: TranscriptBlockTone): string {
  return tone === "subagent" ? "│ " : "  ";
}

function subagentStatusGlyph(status: string, theme: ClankieTranscriptBlockTheme): string {
  const normalized = status.toLowerCase();
  if (normalized === "completed" || normalized === "done") return theme.green("◆");
  if (normalized === "failed" || normalized === "error") return theme.red("◆");
  return theme.cyan("◆");
}

function skillStatusGlyph(status: string, theme: ClankieTranscriptBlockTheme): string {
  const normalized = status.toLowerCase();
  if (normalized === "completed" || normalized === "done") return theme.green("✦");
  if (normalized === "failed" || normalized === "error") return theme.red("✦");
  if (normalized === "rejected" || normalized === "denied") return theme.yellow("✦");
  return theme.yellow("✦");
}
