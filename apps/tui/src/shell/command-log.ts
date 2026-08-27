/**
 * Transcript blocks for slash-command outcomes: a compact `done /cmd` header
 * with an indented, lightly styled body.
 */
import { truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { ClankieFaceAnsiTheme } from "../face/clankie-face-theme.ts";
import { ClankieRenderCache } from "../face/clankie-render-cache.ts";

export type CommandLogTone = "error" | "success";

function formatCommandLogHeader(prompt: string, tone: CommandLogTone, ansi: ClankieFaceAnsiTheme): string {
  const command = slashCommandLabel(prompt);
  const status = tone === "error" ? ansi.red("error") : ansi.green("done");
  return `${status} ${ansi.cyan(command)}`;
}

function slashCommandLabel(prompt: string): string {
  const token = prompt.trim().split(/\s+/u)[0];
  return token?.startsWith("/") === true ? token : "/command";
}

function commandResultBodyLines(message: string): string[] {
  const normalized = message.trim().replace(/\n{3,}/gu, "\n\n");
  if (normalized.length === 0) return [];
  return normalized.split(/\r?\n/u);
}

function styleCommandResultLine(line: string, ansi: ClankieFaceAnsiTheme): string {
  if (line.trim().length === 0) return "";
  const heading = /^([A-Za-z][A-Za-z0-9 /_-]{0,30}:)(.*)$/u.exec(line);
  if (heading !== null) return `${ansi.yellow(heading[1] ?? "")}${heading[2] ?? ""}`;
  if (/^(Usage|Examples):$/u.test(line)) return ansi.dim(line);
  return line;
}

/** Command result with a plain multi-line text body. */
export class ClankieCommandTextResultComponent implements Component {
  private readonly prompt: string;
  private readonly message: string;
  private readonly tone: CommandLogTone;
  private readonly ansi: ClankieFaceAnsiTheme;
  private readonly cache = new ClankieRenderCache();

  constructor(prompt: string, message: string, tone: CommandLogTone, ansi: ClankieFaceAnsiTheme) {
    this.prompt = prompt;
    this.message = message;
    this.tone = tone;
    this.ansi = ansi;
  }

  invalidate(): void {
    this.cache.clear();
  }

  render(width: number): string[] {
    return this.cache.get(width, () => {
      const bodyWidth = Math.max(1, width - 2);
      const lines = [formatCommandLogHeader(this.prompt, this.tone, this.ansi)];
      for (const line of commandResultBodyLines(this.message)) {
        if (line.trim().length === 0) {
          lines.push("");
          continue;
        }
        for (const wrapped of wrapTextWithAnsi(styleCommandResultLine(line, this.ansi), bodyWidth)) {
          lines.push(`  ${truncateToWidth(wrapped, bodyWidth, "", true)}`);
        }
      }
      return lines;
    });
  }
}
