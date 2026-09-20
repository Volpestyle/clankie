import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import type { PendingOperatorPrompt } from "../session/operator-conversations.ts";
import type { ClankieFaceAnsiTheme } from "../face/clankie-face-theme.ts";

/** Accepted inputs remain visible until their durable run settles. */
export class ClankiePendingPrompts implements Component {
  private prompts: readonly PendingOperatorPrompt[] = [];
  private readonly ansi: ClankieFaceAnsiTheme;

  constructor(ansi: ClankieFaceAnsiTheme) {
    this.ansi = ansi;
  }

  setPrompts(prompts: readonly PendingOperatorPrompt[]): void {
    this.prompts = prompts;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.prompts.length === 0) return [];
    const lines = [this.ansi.dim("Accepted inputs · awaiting completion")];
    for (const prompt of this.prompts.slice(0, 3)) {
      lines.push(
        this.ansi.dim(
          `  ↳ ${prompt.delivery === "queue" ? "Follow-up" : "Steer"}: ${prompt.message.replace(/\s+/gu, " ")}`,
        ),
      );
    }
    if (this.prompts.length > 3) lines.push(this.ansi.dim(`  +${this.prompts.length - 3} more`));
    return lines.map((line) => truncateToWidth(line, width, "…"));
  }
}
