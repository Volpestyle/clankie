import type { HerdrAgentSnapshot, HerdrWatchRunner } from "./herdr-watch.ts";

/** Panes with no coding agent in them, as Herdr names them. */
const NOT_AN_AGENT = new Set(["", "unknown", "none", "shell"]);
const ANCHOR_LINES = 3;

/** Runtimes an agent CLI runs under; the script they run names the agent, not them. */
const INTERPRETERS = new Set(["node", "bun", "deno", "python", "python3", "npx", "pnpm", "npm", "env"]);
/** Shells name every prompt's session, never one agent's launch. */
const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "pwsh", "powershell", "cmd", "login"]);

/** A live agent in a pane: its identity, and the command names its launch line would show. */
export interface LiveAgentOccupant {
  readonly key: string;
  readonly commands: ReadonlySet<string>;
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
  const argv0 = command(agent.argv0 ?? agent.argv?.[0] ?? "");
  const commands = new Set(
    [
      pane.agent.trim(),
      command(agent.name),
      argv0,
      ...(INTERPRETERS.has(argv0) && agent.argv?.[1] !== undefined ? [command(agent.argv[1])] : []),
    ].filter((name) => name.length > 1 && !INTERPRETERS.has(name) && !SHELLS.has(name.toLowerCase())),
  );
  return {
    key: JSON.stringify(
      pane.session === undefined
        ? [pane.agent, "process", agent.pid]
        : [pane.agent, pane.session.source, pane.session.value, agent.pid],
    ),
    commands,
  };
}

/** A command word as a shell line shows it: no quotes, directory or executable extension. */
function command(word: string): string {
  return (
    word
      .replace(/^["']+|["']+$/gu, "")
      .split(/[\\/]/u)
      .pop()
      ?.replace(/\.(?:exe|cmd|bat|ps1|js|mjs|cjs)$/iu, "") ?? ""
  );
}

/** What a connected app may read now, and why some of the pane is held back. */
export interface AgentRead {
  readonly text: string;
  readonly detail?: string;
}

const EARLIER_SCREEN_HIDDEN = "Earlier screen hidden until this agent prints something new.";

/**
 * Bounds what a connected app reads from a pane to what its current agent showed (ADR 0307).
 * Terminal history carries no record of who wrote each line, so the first read of an
 * occupant anchors on the line that launched it: the last history line naming its command.
 * That read and every later one return only what follows. Should that line go, the lines
 * the pane held above it at the first read stay hidden by their text. When
 * no line names the command, nothing the pane held at that first read is shown, only lines
 * the agent writes after it, and the read says so. A new occupant gets a new anchor.
 */
export class AgentReadScope {
  private readonly anchors = new Map<
    string,
    {
      readonly occupant: string;
      readonly anchor: readonly string[];
      /** Text the pane held before this agent, never shown even if the anchor is lost. */
      readonly earlier: ReadonlySet<string>;
      /** The launch line could not be found, so the whole first screen is held back. */
      readonly closed: boolean;
    }
  >();

  public bound(terminalId: string, occupant: LiveAgentOccupant, history: string, screen: string): AgentRead {
    let entry = this.anchors.get(terminalId);
    if (entry?.occupant !== occupant.key) {
      const launch = launchLine(history, occupant.commands);
      const lines = history.split("\n");
      entry =
        launch === undefined
          ? {
              occupant: occupant.key,
              anchor: anchorAbove(history, screen),
              earlier: written(lines),
              closed: true,
            }
          : {
              occupant: occupant.key,
              anchor: nonEmptyEndingAt(lines, launch),
              earlier: written(lines.slice(0, launch + 1)),
              closed: false,
            };
      this.anchors.set(terminalId, entry);
    }
    const cut = after(history, entry.anchor);
    // A cut at the launch line needs nothing more. Without one, the pane's earlier text is
    // held back line by line, so an anchor redrawn away still reveals nothing before it.
    if (cut !== undefined && !entry.closed) return { text: cut };
    const lines = (cut ?? history).split("\n");
    const earlier = entry.earlier;
    const shown = lines.filter((line) => !earlier.has(compact(line)));
    return {
      text: shown.join("\n"),
      ...(entry.closed && shown.length < lines.length ? { detail: EARLIER_SCREEN_HIDDEN } : {}),
    };
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
 * The index of the last history line with a word that is one of the agent's command names,
 * as the shell echoed the command that started it. A later line naming it is only ever below
 * the real one, so the cut hides more, never less. A line that may run other commands before
 * the agent (`cat .env && claude`, a pipe, a substitution, a continued line) is no boundary:
 * their output would follow it, so there is no launch line then.
 */
function launchLine(history: string, commands: ReadonlySet<string>): number | undefined {
  if (commands.size === 0) return undefined;
  const lines = history.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index]!.split(/\s+/u).some((word) => commands.has(command(word)))) continue;
    let above = index - 1;
    while (above >= 0 && lines[above]!.trim().length === 0) above -= 1;
    const continued = above >= 0 && CONTINUES.test(lines[above]!);
    return continued || COMPOUND.test(lines[index]!) ? undefined : index;
  }
  return undefined;
}

/** Shell syntax that can run another command on the same line: lists, pipes, substitutions. */
const COMPOUND = /&&|\|\||[;|&`]|\$\(|<\(|>\(/u;
/** A line the shell carries on to the next one (POSIX `\`, PowerShell backtick, a dangling operator). */
const CONTINUES = /(?:\\|`|&&|\|\||\|)\s*$/u;

/** Up to ANCHOR_LINES non-empty lines ending with the line at `end`. */
function nonEmptyEndingAt(lines: readonly string[], end: number): readonly string[] {
  const anchor = [lines[end]!];
  for (let above = end - 1; above >= 0 && anchor.length < ANCHOR_LINES; above -= 1)
    if (lines[above]!.trim().length > 0) anchor.unshift(lines[above]!);
  return anchor;
}

const compact = (line: string) => line.replace(/\s+/gu, "");

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
