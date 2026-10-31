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
  the pane starts over. A refused read also drops the pane's anchor.
- **History starts at the line that launched the occupant.** Scrollback
  carries no author per line, so the first read of an occupant looks for the
  line the shell echoed when it started: the last history line with a word
  equal to the agent's command name (Herdr's agent name, or its process's name
  or executable, or the script an interpreter such as `node` runs, without
  directory or `.exe`-style extension). The anchor is that line and up to two
  non-empty lines above it, and that read and every later one return only what
  follows it, even shell work still on the screen when the agent started. A new
  occupant gets a new anchor. Scrollback loses lines only from its top, so while
  part of the anchor is still in the read window its last lines stand first
  there, and the cut falls after them. A later line naming the command is only
  ever below the real launch, so picking the last one can hide some of the
  agent's own output, never show earlier text. A line that can run other
  commands before the agent is no boundary, since their output follows it: a
  list, pipe or background operator (`&&`, `||`, `;`, `|`, `&`), a command
  substitution, or a line the one above carries on into (a trailing `\`,
  backtick or operator). Then there is no launch line.
- **If the anchor goes, earlier text stays out line by line.** The first read
  also keeps the text of every line above the launch line. Once the anchor is
  wholly gone, scrolled out or redrawn by the agent, the read is the window
  with every line whose text matches one of those removed.
- **Without a launch line, the first screen is held back.** When no line names
  the command (an alias, a wrapper, a launch already scrolled out), nothing the
  pane showed at the first read is returned: the anchor is the few non-empty
  lines above the screen then, and every line whose text was in that first
  read is removed from this and later reads. Only lines the agent writes after
  that come through, and the read carries the detail "Earlier screen hidden
  until this agent prints something new." The connector's `read_agent` passes
  it on as `note`, so a lead sees why the read is empty instead of taking it
  for an empty pane. Anchors live in the service's memory, per Herdr runner and
  terminal.
- **A refusal is final.** The connector's Herdr session source used to stream
  the screen when `terminal_read` did not answer `read`. It now streams only
  for a service that has no `terminal_read` at all; any answer from that op,
  refusals and unreachable machines included, is passed back as the refusal.

## Consequences

- A connected app can no longer read a shell, or text from before the agent it
  asked for.
- After a service restart the next read anchors afresh at the screen, so it
  can show less than the agent's whole run, never more.
- An agent that clears its own scrollback loses its anchor and is read from
  what remains, which is its own output.
- When the exact anchor lines appear more than once, the read is cut at their
  last appearance, which can drop some of the agent's own lines but never adds
  earlier ones.
- Lines held back by their text also drop an agent line that repeats that text
  exactly (a banner or a border), only while the agent has no launch line or
  after its anchor is gone.
- An agent started under an alias in a pane whose window still holds an older
  line with its real command name above the owner's later shell work is cut at
  that older line, so the shell work between them is shown. The launch line
  can't be told from such a line by its text; the owner avoids it by starting
  agents by their own name, or in a fresh pane.
