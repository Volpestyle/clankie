# ADR 0307: A connector reads only a live agent's own output

Status: Accepted, 2026-10-31. Amends
[ADR 0301](0301-claude-reaches-the-fleet-through-a-narrow-connector.md).
Amended 2026-11-02 for [#328](https://github.com/Volpestyle/clankie/issues/328):
Claude Code and Codex are read from their own session transcript.

## Context

A connected app reads an agent with `read_agent`, which reaches the operator
op `terminal_read`. That op returned the pane's recent scrollback for any
terminal Herdr could resolve. A pane outlives the agent in it: once the agent
exits, the same pane is the owner's shell, and its scrollback still holds
whatever ran there before the agent started, or what an earlier agent showed.
So a connector granted to read agents could read a plain shell and the owner's
work in it (a `cat .env`, a token printed by a login).

## Decision

`terminal_read` answers only for a live coding agent, and only with what that
agent showed.

- **A live agent is in the pane now.** Herdr detects an agent there (not
  `unknown`, `none` or `shell`), and the pane has a foreground process that is
  not its own shell (`herdr pane process-info`). An agent launched as the
  pane's own command is its root process, not a shell by name, and counts. Otherwise the read is refused:
  "No coding agent is running in that pane now." This holds on every machine;
  `process-info` is one of the verbs the fleet runner may run over ssh.
- **The occupant is named by native identity.** The agent Herdr detects, its
  native session when Herdr knows one, and the agent's own foreground process:
  the one taken for it at the last read while it is still there, else one
  named for the agent, else the lowest non-shell pid. Pids don't order
  processes by age everywhere (Windows reuses low ones), so a subprocess
  starting or ending doesn't move the occupant. A different occupant is a different
  agent, so an agent resumed into the same native session after the shell had
  the pane starts over. A refused read also drops the pane's anchor. The
  occupant is checked again after the pane is read; if it changed in between,
  nothing read is returned.
- **Nothing the pane held at the first read is shown.** Scrollback carries no
  author per line, and the line that launched an agent can't be told from an
  older one by its text: an alias (`cc`), a wrapper script (`start-coding`), a
  launch run inside a longer command or a multiline block, or an older launch
  by the agent's own name with the owner's shell work below it. So the service
  never guesses a launch line. At an occupant's first read it anchors on the
  few non-empty history lines above the screen, keeps the rows below them up
  to the last that holds text, and keeps the text of every line the pane held.
  That read and every later one return rows below the kept ones, and a kept
  row only once the agent has drawn over it: a full-screen agent redraws its
  own rows in place, and what it draws there is its output. A kept row that
  still carries any run of four characters of its first-read text, spacing
  aside, stays hidden, since an agent can overwrite only part of a row (a
  carriage return, or output carried on from a line with no newline) and leave
  the rest of the owner's text there. When the whole first screen fit with
  nothing above it, rows are counted from the window's top until a later
  read finds lines above the screen to anchor on. Lines whose text was in that
  first read are also removed. When the anchor is gone, scrolled out or
  redrawn away, that read shows nothing and anchors again above the screen,
  keeping every row there the same way; the text held at the first read stays held. While
  anything is held back the read carries the detail "Earlier screen hidden
  until this agent prints something new." The connector's `read_agent` passes
  it on as `note`, so a lead sees why the read is empty instead of taking it
  for an empty pane. A new occupant gets a new anchor. Anchors live in the
  service's memory, per Herdr runner and terminal.
- **The Herdr desktop app's agents are read the same way.** Its terminal
  server, herdr-core (`hc`), keeps a status a program reported until the
  terminal's own program ends, so an agent that exits back to its shell
  leaves its last word behind. A herdr-core terminal has a live agent when its
  program reported a status that still stands and the process in front is not
  a shell (`terminal.get`'s `pid`, `argv` and `foreground`); the agent is the
  terminal's own program unless that is a shell, else the process in front.
  The occupant is the terminal, its root process and the agent's pid, checked
  again after the read. `herdr_core_read` reads history and screen and passes
  them through the same scope, with anchors kept per core and terminal, and
  `herdr_core_list` lists only terminals that hold such an agent (added
  2026-10-31).
- **A refusal is final.** The connector's Herdr session source used to stream
  the screen when `terminal_read` did not answer `read`. It now streams only
  for a service that has no `terminal_read` at all; any answer from that op,
  refusals and unreachable machines included, is passed back as the refusal.

- **Claude Code and Codex are read from their own transcript** (amended
  2026-11-02, #328). Terminal text has no author per line, so the cut above
  is a heuristic, and its known gaps below can show the owner's shell work.
  For a live Claude Code or Codex occupant with a native session, the read
  is the tail of that session's own transcript instead of the pane: prompts
  marked `›`, the agent's replies, a `·` line per tool call or interruption;
  internal channel deliveries and image paths are left out. It is found as
  the fleet already finds a seat's transcript (the harness's own session
  files on this Mac, the confined transcript host over ssh on a linked PC),
  and returned only if the same occupant, session included, holds the pane
  after the read. The read carries the detail "Read from this agent's own
  session transcript, not its screen." A menu or question the agent waits
  on is drawn on its screen only, and `answer_prompt` needs its text, so
  while Herdr reports the agent `blocked` the read adds, under "Waiting on
  input, on its screen now:", the visible rows of its screen that the cut
  above lets through (all of them for a hire read whole), never scrollback.
  Every transcript read passes the screen through the cut, so its anchor is
  set before a prompt is drawn. When no transcript can be read (no
  session reported, no file yet, an unreachable host), the read is refused;
  the screen is never shown in its place. Other harnesses keep the screen
  read and its cut, and so do the Herdr desktop app's own terminals
  (`herdr_core_read`), whose owner-started agents carry no session identity.

## Consequences

- A connected app can no longer read a shell, or text from before the agent it
  asked for.
- After a service restart the next read anchors afresh at the screen, so it
  can show less than the agent's whole run, never more.
- An agent that clears its own scrollback loses its anchor: that read shows
  nothing, and later reads show what it writes below the rows then.
- The first read of an agent is empty, and an agent's output from before
  anything first read it stays hidden. A kept row the agent redraws with text
  close to what it held (a status line that changes a word, a border) stays
  hidden until it changes more, and up to three characters of a first-read row
  can show in a row the agent drew over. A lead reads again once the agent has printed
  something.
- When the exact anchor lines appear more than once, the read is cut at their
  last appearance, which can drop some of the agent's own lines but never adds
  earlier ones.
- Lines held back by their text also drop an agent line that repeats that text
  exactly (a banner or a border).
- For Claude Code and Codex in a Herdr pane, the transcript read (#328)
  closes the gaps below: the suspend case, a launch inside a longer command or
  multiline block, reprinted or reflowed lines and a hired session resumed by
  hand, except while the agent waits on input: then the visible rows the
  cut lets through are added, so shell text left visible below the anchor
  after a suspend and `fg` can show there until the agent draws over it. A
  Claude Code or Codex agent whose transcript can't be found is now
  unreadable instead of read from its screen, and when it isn't waiting on
  input a read shows only what it wrote to its session, not its live screen.
  The gaps below remain for other harnesses and for the desktop app's
  terminals.
- One case still shows the owner's own shell work. An agent suspended
  (Ctrl-Z), with shell commands run and then brought back with `fg`, keeps its
  process and session, so its anchor holds and the shell work in between is
  read. It needs the owner to print private text in an agent's pane
  mid-session. Exact provenance would come from a host-proven boundary, such
  as reading a Claude Code or Codex agent's own session transcript instead of
  its screen, left as a follow-up.
- A line from the first read that comes back below the kept rows with
  different text (reprinted with a prefix, or reflowed by a resize) no longer
  matches what is held back and can be shown. The read uses unwrapped history, which a resize should not
  reflow, but this hasn't been checked against real Herdr. It and the suspend
  case are tracked as VUH-2979.
- A hire in the Herdr desktop app's terminals (ADR 0319) is read whole. Its
  terminal runs only a silent launcher that execs the harness Clankie started, so
  nothing in it is the owner's, and holding back its first screen would only
  blind its lead. The owner's own desktop-app terminals keep the cut.
- A hire in a Herdr pane, on this Mac or a linked PC, is read whole too
  (amended 2026-11-01, #298). Clankie opened that tab for the hire, so its
  history holds only the shell's start, his own launch line and the agent's
  output; holding back the first screen left a quiet hire (waiting on CI)
  unreadable to its lead. It counts only while the fleet roster carries a hire
  claim (`owner.hired`) for that seat and for the exact native session in the
  pane now; an adopted or hand-started agent, or a different session in the
  same pane, keeps the cut. The claim names the session, not the process, so a
  hired session the owner resumes by hand in that pane after shell work there
  would show that shell work, the same kind of gap as the suspend case above.
