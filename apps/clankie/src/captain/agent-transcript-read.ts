import type { HerdrTranscriptEntry } from "@clankie/agent-transcript";

/**
 * Harnesses read from their own session transcript instead of their screen (#328).
 * Terminal text carries no author per line, so a screen read can show the
 * owner's shell work (a suspend and `fg`, a launch inside a longer block); a
 * transcript holds only what that session's agent and its prompts said.
 */
export const TRANSCRIPT_READ_HARNESSES: ReadonlySet<string> = new Set(["claude", "codex"]);

export const TRANSCRIPT_READ_DETAIL = "Read from this agent's own session transcript, not its screen.";

/** Heads the screen a blocked agent shows: its menu or question waits there, not in its transcript. */
export const TRANSCRIPT_WAITING_HEADING = "Waiting on input, on its screen now:";

export const TRANSCRIPT_READ_REFUSED =
  "This agent's own session transcript can't be read now, and its screen is never shown in its place; read it again once it has written to its session.";

/**
 * The transcript as plain lines, oldest first: prompts marked `›`, the agent's
 * replies as written, tool calls and interruptions as one short `·` line each.
 * Internal channel deliveries and viewed-image host paths are left out.
 */
export function transcriptReadText(entries: readonly HerdrTranscriptEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.type === "message") {
      if (entry.internal === true || !entry.text.trim()) continue;
      lines.push(entry.role === "operator" ? `› ${entry.text}` : entry.text);
    } else if (entry.type === "tool") {
      if (entry.phase === "started") lines.push(`· ${entry.name}`);
      else if (entry.phase === "failed") lines.push(`· ${entry.name} failed`);
    } else if (entry.type === "interrupted") lines.push("· interrupted");
  }
  return lines.join("\n");
}
