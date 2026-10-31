import type { HerdrAgentSnapshot, HerdrWatchRunner } from "./herdr-watch.ts";

/** Panes with no coding agent in them, as Herdr names them. */
const NOT_AN_AGENT = new Set(["", "unknown", "none", "shell"]);
const ANCHOR_LINES = 3;

/** A live agent in a pane, by its identity. */
export interface LiveAgentOccupant {
  readonly key: string;
}

/**
 * The agent occupying a pane now, by native identity: the agent Herdr detects, its native
 * session when Herdr knows it, and its live foreground process that is not the pane's shell.
 * The process is always part of it, so an agent resumed into the same native session after
 * the shell had the pane is a new occupant. Undefined when the pane holds no live agent.
 */
export async function liveAgentOccupant(
  runner: HerdrWatchRunner,
  pane: HerdrAgentSnapshot,
): Promise<LiveAgentOccupant | undefined> {
  if (NOT_AN_AGENT.has(pane.agent.trim().toLowerCase())) return undefined;
  if (runner.paneShell === undefined) return undefined;
  const { shellPid, foreground } = await runner.paneShell(pane.paneId);
  const occupants = foreground.filter(({ pid }) => Number.isSafeInteger(pid) && pid > 1 && pid !== shellPid);
  if (occupants.length === 0) return undefined;
  // The oldest foreground process is the agent itself; its own subprocesses come after it.
  const agent = occupants.reduce((oldest, process) => (process.pid < oldest.pid ? process : oldest));
  return {
    key: JSON.stringify(
      pane.session === undefined
        ? [pane.agent, "process", agent.pid]
        : [pane.agent, pane.session.source, pane.session.value, agent.pid],
    ),
  };
}

/** What a connected app may read now, and why some of the pane is held back. */
export interface AgentRead {
  readonly text: string;
  readonly detail?: string;
}

const EARLIER_SCREEN_HIDDEN = "Earlier screen hidden until this agent prints something new.";

/**
 * Bounds what a connected app reads from a pane to what its current agent showed (ADR 0307).
 * Terminal history carries no record of who wrote each line, and the line that launched the
 * agent can't be told from an older launch by its text (an alias, a launch run inside a
 * longer command), so nothing the pane held when an occupant is first read is ever returned
 * for it. That first read anchors on the few lines above its screen and keeps the text of
 * every line it saw; this read and every later one return only lines written since, and say
 * so while anything is held back. A new occupant gets a new anchor.
 */
export class AgentReadScope {
  private readonly anchors = new Map<string, Anchor>();

  public bound(terminalId: string, occupant: LiveAgentOccupant, history: string, screen: string): AgentRead {
    let entry = this.anchors.get(terminalId);
    if (entry?.occupant !== occupant.key) {
      entry = {
        occupant: occupant.key,
        ...placed(history, screen),
        earlier: written(history.split("\n")),
        tail: compact(history.split("\n").findLast((line) => line.trim().length > 0) ?? ""),
      };
      this.anchors.set(terminalId, entry);
    } else if (entry.anchor.length === 0) {
      // Everything fit on the first read's screen, so its rows were counted from the window's
      // top. Once lines stand above the screen, anchor on them before the window can scroll.
      const anchor = anchorAbove(history, screen);
      const cut = after(history, anchor);
      if (anchor.length > 0 && cut !== undefined) {
        const above = history.split("\n").length - cut.split("\n").length;
        entry = { ...entry, anchor, rows: entry.rows.slice(above) };
        this.anchors.set(terminalId, entry);
      }
    }
    const cut = after(history, entry.anchor);
    if (cut === undefined) {
      // The anchor is gone, scrolled out or redrawn away, so where this read starts can't be
      // placed. Show nothing now and anchor again above the current screen, holding the rows
      // there; the text held at the first read stays held.
      this.anchors.set(terminalId, { ...entry, ...placed(history, screen) });
      return { text: "", detail: EARLIER_SCREEN_HIDDEN };
    }
    const lines = cut.split("\n");
    const { earlier, tail, rows } = entry;
    // Rows the first read saw stay hidden until the agent has drawn over them: a full-screen
    // agent redraws its own rows in place, and what it draws there is its output. A row that
    // still carries a run of its first-read text stays hidden, since an agent can overwrite only
    // part of one and leave the rest of the owner's text there.
    const fresh = lines.filter((line, index) => index >= rows.length || redrawn(compact(line), rows[index]!));
    // Held back line by line too, and a line that carries on the first read's last line keeps
    // that line's text hidden, for reads placed after the anchor was lost.
    const kept = fresh.filter((line) => !earlier.has(compact(line)));
    const shown = kept.map((line) => withoutPrefix(line, tail));
    // Blank lines left above the first shown one were the held-back text's spacing.
    const first = shown.findIndex((line) => line.trim().length > 0);
    const held = shown.length < lines.length || shown.some((line, index) => line !== kept[index]);
    return {
      text: (first < 0 ? [] : shown.slice(first)).join("\n"),
      ...(held ? { detail: EARLIER_SCREEN_HIDDEN } : {}),
    };
  }

  /** The pane has no live agent now; whoever comes next starts from their own screen. */
  public forget(terminalId: string): void {
    this.anchors.delete(terminalId);
  }
}

interface Anchor {
  readonly occupant: string;
  /** The few history lines above the screen when this occupant was placed. */
  readonly anchor: readonly string[];
  /** The rows below the anchor then, by text; each stays hidden until it is drawn over. */
  readonly rows: readonly string[];
  /** Text the pane held at this occupant's first read, never shown for it. */
  readonly earlier: ReadonlySet<string>;
  /** That read's last line, which output written after it can extend in place. */
  readonly tail: string;
}

/** An anchor above the screen, and the rows below it up to the last that holds text now. */
function placed(
  history: string,
  screen: string,
): { readonly anchor: readonly string[]; readonly rows: readonly string[] } {
  const anchor = anchorAbove(history, screen);
  const below = (after(history, anchor) ?? history).split("\n");
  return {
    anchor,
    rows: below.slice(0, below.findLastIndex((line) => line.trim().length > 0) + 1).map(compact),
  };
}

/** Shortest run of a held row's text that keeps the row hidden where it still stands. */
const REMNANT = 4;

/**
 * Whether a row, by text, has been drawn over since it held `before`: it shares no run of
 * `REMNANT` characters with that text (or, for shorter text, doesn't contain it). A blank row
 * held nothing.
 */
function redrawn(now: string, before: string): boolean {
  if (before.length === 0) return true;
  if (before.length < REMNANT) return !now.includes(before);
  for (let start = 0; start + REMNANT <= before.length; start += 1)
    if (now.includes(before.slice(start, start + REMNANT))) return false;
  return true;
}

const scopes = new WeakMap<HerdrWatchRunner, AgentReadScope>();

/** One scope per Herdr runner, so every read through the same service shares anchors. */
export function agentReadScope(runner: HerdrWatchRunner): AgentReadScope {
  let scope = scopes.get(runner);
  if (scope === undefined) {
    scope = new AgentReadScope();
    scopes.set(runner, scope);
  }
  return scope;
}

const compact = (line: string) => line.replace(/\s+/gu, "");

/**
 * The line without a leading run of `prefix`'s text, spacing aside. Output written after a
 * line that had no newline yet lands on that same line, so the line read later starts with
 * text that was held back.
 */
function withoutPrefix(line: string, prefix: string): string {
  if (prefix.length === 0) return line;
  let matched = 0;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (/\s/u.test(char)) continue;
    if (char !== prefix[matched]) return line;
    matched += 1;
    if (matched === prefix.length) return line.slice(index + 1);
  }
  return line;
}

/** Every non-empty line's text, ignoring spacing a redraw can change. */
function written(lines: readonly string[]): ReadonlySet<string> {
  return new Set(lines.map(compact).filter((line) => line.length > 0));
}

/**
 * The last few non-empty history lines above the screen. Lines whose text also shows on the
 * screen are passed over, so the cut never reveals text that was not already visible.
 */
function anchorAbove(history: string, screen: string): readonly string[] {
  const shown = screen.replace(/\s+/gu, "");
  const lines = history.split("\n");
  const anchor: string[] = [];
  let index = lines.length - 1;
  for (; index >= 0; index -= 1) {
    const line = lines[index]!.replace(/\s+/gu, "");
    if (line.length > 0 && !shown.includes(line)) break;
  }
  for (; index >= 0 && anchor.length < ANCHOR_LINES; index -= 1) {
    if (lines[index]!.trim().length > 0) anchor.unshift(lines[index]!);
  }
  return anchor;
}

/**
 * History after the last place the anchor's lines stand in order. The last place is never
 * above the real anchor, so a repeat cuts away the agent's own lines rather than revealing
 * earlier ones. Scrollback loses lines only from its top, so an anchor partly scrolled out
 * leaves its last lines first in the window, and the cut falls after those. Undefined when the
 * anchor is wholly gone, scrolled out or redrawn away.
 */
function after(history: string, anchor: readonly string[]): string | undefined {
  if (anchor.length === 0) return history;
  const lines = history.split("\n");
  const written = lines.flatMap((line, index) => (line.trim().length > 0 ? [index] : []));
  for (let start = written.length - anchor.length; start >= 0; start -= 1) {
    if (anchor.every((line, offset) => lines[written[start + offset]!]!.trimEnd() === line.trimEnd()))
      return lines.slice(written[start + anchor.length - 1]! + 1).join("\n");
  }
  for (let kept = Math.min(anchor.length - 1, written.length); kept > 0; kept -= 1) {
    const rest = anchor.slice(anchor.length - kept);
    if (rest.every((line, offset) => lines[written[offset]!]!.trimEnd() === line.trimEnd()))
      return lines.slice(written[kept - 1]! + 1).join("\n");
  }
  return undefined;
}
