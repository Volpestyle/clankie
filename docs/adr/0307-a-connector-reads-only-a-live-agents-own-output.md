# ADR 0307: A connector reads only a live agent's own output

Status: Accepted, 2026-10-31. Amends
[ADR 0301](0301-claude-reaches-the-fleet-through-a-narrow-connector.md).

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
  not its own shell (`herdr pane process-info`). Otherwise the read is refused:
  "No coding agent is running in that pane now." This holds on every machine;
  `process-info` is one of the verbs the fleet runner may run over ssh.
- **The occupant is named by native identity.** The agent Herdr detects, its
  native session when Herdr knows one, and its oldest non-shell foreground
  process, which is the agent itself. A different occupant is a different
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
- **A refusal is final.** The connector's Herdr session source used to stream
  the screen when `terminal_read` did not answer `read`. It now streams only
  for a service that has no `terminal_read` at all; any answer from that op,
  refusals and unreachable machines included, is passed back as the refusal.

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
