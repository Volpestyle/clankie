import type { HerdrTranscriptEntry } from "@clankie/agent-transcript";

/**
 * Harnesses read from their own session transcript instead of their screen (#328).
 * Terminal text carries no author per line, so a screen read can show the
 * owner's shell work (a suspend and `fg`, a launch inside a longer block); a
 * transcript holds only what that session's agent and its prompts said.
 */
export const TRANSCRIPT_READ_HARNESSES: ReadonlySet<string> = new Set(["claude", "codex"]);

export const TRANSCRIPT_READ_DETAIL = "Read from this agent's own session transcript, not its screen.";

/**
 * Heads the screen a blocked agent shows, for a hire launched as its pane's own command, whose
 * screen nothing else can draw on: its menu or question waits there, not in its transcript.
 */
export const TRANSCRIPT_WAITING_HEADING = "Waiting on input, on its screen now:";

/**
 * Heads the calls any other blocked agent waits on, from its own session. Its screen is never
 * read: an agent with a shell under it can be suspended into that shell, and after `fg` an
 * inline TUI repaints only its own rows, so shell work can stand on screen above its menu, and
 * no row says who wrote it.
 */
export const TRANSCRIPT_WAITING_CALL_HEADING = "Waiting on input, for this call in its session:";

/** Said instead when such an agent has no call waiting in its session. */
export const TRANSCRIPT_WAITING_UNSHOWN =
  "Waiting on input its session doesn't record (a menu of its own). This agent's screen isn't read, so that prompt's text isn't shown.";

export const TRANSCRIPT_READ_REFUSED =
  "This agent's own session transcript can't be read now, and its screen is never shown in its place; read it again once it has written to its session.";

/**
 * A channel delivery (a lead's or peer's message, or a receipt) as one prompt line that names
 * who sent it, the way the pane shows it (#220). Undefined for any other internal entry, such as
 * the brief a hire was launched with.
 */
function channelDeliveryLine(text: string): string | undefined {
  const match = /^<channel\b([^>]*)>([\s\S]*?)(?:<\/channel>)?\s*$/u.exec(text.trimStart());
  if (match === null) return undefined;
  // The plugin names itself first; the last `source` is the sender (`captain`, `peer`, a receipt).
  const from = [...match[1]!.matchAll(/\bsource="([^"]*)"/gu)].at(-1)?.[1];
  const body = match[2]!.trim();
  return body ? `› [channel${from ? ` from ${from}` : ""}] ${body}` : undefined;
}

/**
 * The transcript as plain lines, oldest first: prompts marked `›`, channel messages as
 * `› [channel from …]`, the agent's replies as written, tool calls and interruptions as one short
 * `·` line each. Other internal entries (a hire's launch brief) and viewed-image host paths are
 * left out.
 */
export function transcriptReadText(entries: readonly HerdrTranscriptEntry[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.type === "message") {
      if (!entry.text.trim()) continue;
      if (entry.internal === true) {
        const delivery = entry.role === "operator" ? channelDeliveryLine(entry.text) : undefined;
        if (delivery !== undefined) lines.push(delivery);
        continue;
      }
      lines.push(entry.role === "operator" ? `› ${entry.text}` : entry.text);
    } else if (entry.type === "tool") {
      if (entry.phase === "started") lines.push(`· ${entry.name}`);
      else if (entry.phase === "failed") lines.push(`· ${entry.name} failed`);
    } else if (entry.type === "interrupted") lines.push("· interrupted");
  }
  return lines.join("\n");
}

/**
 * The tool calls the agent started and hasn't finished since its last prompt or interruption,
 * one `·` line each with its arguments: what a permission prompt or question asks about.
 * Undefined when none is open.
 */
function transcriptWaitingCalls(entries: readonly HerdrTranscriptEntry[]): string | undefined {
  const finished = new Set(
    entries.flatMap((entry) =>
      entry.type === "tool" && entry.phase !== "started" ? [entry.toolCallId] : [],
    ),
  );
  const since = entries.findLastIndex(
    (entry) => entry.type === "interrupted" || (entry.type === "message" && entry.role === "operator"),
  );
  const open = entries
    .slice(since + 1)
    .flatMap((entry) =>
      entry.type === "tool" && entry.phase === "started" && !finished.has(entry.toolCallId)
        ? [entry.detail?.trim() ? `· ${entry.name} ${entry.detail.trim()}` : `· ${entry.name}`]
        : [],
    );
  return open.length === 0 ? undefined : open.join("\n");
}

/**
 * What a blocked agent waits on, for its transcript read: the rows of its screen when `screen`
 * is given (a hire that is its pane's root process), else the calls open in its session.
 */
export function transcriptWaiting(
  entries: readonly HerdrTranscriptEntry[],
  screen: string | undefined,
): string | undefined {
  if (screen !== undefined) {
    const rows = screen.split("\n").filter((line) => line.trim());
    return rows.length === 0 ? undefined : [TRANSCRIPT_WAITING_HEADING, ...rows].join("\n");
  }
  const calls = transcriptWaitingCalls(entries);
  return calls === undefined ? TRANSCRIPT_WAITING_UNSHOWN : `${TRANSCRIPT_WAITING_CALL_HEADING}\n${calls}`;
}
