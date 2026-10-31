import type { HerdrAgentSnapshot, HerdrWatchRunner } from "./herdr-watch.ts";

/** Panes with no coding agent in them, as Herdr names them. */
const NOT_AN_AGENT = new Set(["", "unknown", "none", "shell"]);
const ANCHOR_LINES = 3;

/**
 * The agent occupying a pane now, by native identity: the agent Herdr detects, its native
 * session when Herdr knows it, and its live foreground process that is not the pane's shell.
 * The process is always part of it, so an agent resumed into the same native session after
 * the shell had the pane is a new occupant. Undefined when the pane holds no live agent.
 */
export async function liveAgentOccupant(
  runner: HerdrWatchRunner,
  pane: HerdrAgentSnapshot,
): Promise<string | undefined> {
  if (NOT_AN_AGENT.has(pane.agent.trim().toLowerCase())) return undefined;
  if (runner.paneShell === undefined) return undefined;
  const { shellPid, foreground } = await runner.paneShell(pane.paneId);
  const occupants = foreground
    .map((process) => process.pid)
    .filter((pid) => Number.isSafeInteger(pid) && pid > 1 && pid !== shellPid);
  if (occupants.length === 0) return undefined;
  // The oldest foreground process is the agent itself; its own subprocesses come after it.
  const process = Math.min(...occupants);
  return JSON.stringify(
    pane.session === undefined
      ? [pane.agent, "process", process]
      : [pane.agent, pane.session.source, pane.session.value, process],
  );
}

/**
 * Bounds what a connected app reads from a pane to what its current agent showed (ADR 0307).
 * Terminal history carries no record of who wrote each line, so the first read of an
 * occupant anchors on the scrollback just above its screen then; that read and every later
 * one return only what follows. A new occupant gets a new anchor. Scrollback above the
 * screen never changes, so an anchor that is gone took everything before it along.
 */
export class AgentReadScope {
  private readonly anchors = new Map<
    string,
    { readonly occupant: string; readonly anchor: readonly string[] }
  >();

  public bound(terminalId: string, occupant: string, history: string, screen: string): string {
    let entry = this.anchors.get(terminalId);
    if (entry?.occupant !== occupant) {
      entry = { occupant, anchor: anchorAbove(history, screen) };
      this.anchors.set(terminalId, entry);
    }
    return after(history, entry.anchor);
  }

  /** The pane has no live agent now; whoever comes next starts from their own screen. */
  public forget(terminalId: string): void {
    this.anchors.delete(terminalId);
  }
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
 * leaves its last lines first in the window, and the cut falls after those. Only an anchor
 * wholly gone returns everything.
 */
function after(history: string, anchor: readonly string[]): string {
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
  return history;
}
