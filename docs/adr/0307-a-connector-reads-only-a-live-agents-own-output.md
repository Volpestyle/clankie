# ADR 0307: A connector reads only a live agent's own output

Status: Accepted, 2026-10-31. Amends
[ADR 0301](0301-claude-reaches-the-fleet-through-a-narrow-connector.md).
Amended 2026-11-02 for [#328](https://github.com/Volpestyle/clankie/issues/328):
Claude Code and Codex are read from their own session transcript. Amended
2026-11-03: the prompt such an agent waits on comes from its session, not its
screen, unless Clankie hired it.

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
  again after the read. For other harnesses, `herdr_core_read` reads history
  and screen and passes them through the same scope, with anchors kept per core
  and terminal (Claude Code and Codex are read from their transcript, below), and
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
  a channel message it received (a lead's, a peer's or a receipt) as
  `› [channel from SENDER]` with its text, as its pane shows it (amended
  2026-11-03, [#220](https://github.com/Volpestyle/clankie/issues/220));
  a hire's launch brief and image paths are left out. It is found as
  the fleet already finds a seat's transcript (the harness's own session
  files on this Mac, the confined transcript host over ssh on a linked PC),
  and returned only if the same occupant (agent, session and process) holds
  the pane after the read, by Herdr's pane list read again then, never a
  copy a runner kept. The read carries the detail "Read from this agent's own
  session transcript, not its screen." While Herdr reports the agent
  `blocked`, the read says what it waits on. For an agent the owner started,
  that is the tool calls it started and hasn't finished since its last
  prompt, from the same transcript, under "Waiting on input, for this call in
  its session:"; with none open (a menu of the harness's own, such as a model
  picker) the read says a prompt waits whose text isn't shown. Its screen is
  never read, not even through the cut above: after a suspend and `fg` an
  inline TUI repaints only its own rows, so the owner's shell work can stand
  on screen above its menu, written after any anchor, and no row says who
  wrote it. The same holds for a hire run under a shell (a hire whose pane
  started a shell first, or a hired session the owner resumed by hand in
  their own shell): it can be suspended into that shell like any agent, so
  its waiting text comes from its session too. Only a hire launched as its
  pane's own command, the pane's root process with no shell under it, has
  nothing else drawing on its screen; for it the visible rows of its screen
  are added instead, under "Waiting on input, on its screen now:". When no
  transcript can be read (no
  session reported, no file yet, an unreachable host), the read is refused;
  the screen is never shown in its place. Other harnesses keep the screen
  read and its cut. The Herdr desktop app's own terminals (`herdr_core_read`)
  read Claude Code and Codex from their transcript too
  ([#530](https://github.com/Volpestyle/clankie/issues/530)). An agent the
  owner started there carries no session Clankie named, so its session is the
  one the harness's own files name for that exact process lifetime:
  - The process's kernel identity and birth are taken before anything is looked
    up and checked again after the transcript is read and the terminal is seen
    once more. A process that died, a pid that became another process's, or a
    lifetime that can't be observed is refused.
  - Claude Code's `sessions/<pid>.json` in its config home counts only when its
    recorded start (`procStart`, `ps -o lstart` in UTC) is exactly that birth's
    second, printed the same way, and its `startedAt` (ms) is at or after the
    birth itself. An earlier process on the pid, even one born in the same
    printed second, started before this one and fails the second test.
  - For Codex, the one rollout the process holds open for writing, and only if
    Codex's own lookup by that id finds the same file. A descriptor opened only
    to read names nothing.
  - Either way the transcript must be a regular file the owner owns, at its
    canonical path, with no symlink anywhere along it, its config home
    included.

  Anything short of exactly one such session, or no transcript, is refused. Its
  screen is never read, so a menu it waits on is named from its session alone.

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
- For Claude Code and Codex in a Herdr pane, or in the desktop app's terminals
  (#530), the transcript read (#328) closes the gaps below: the suspend case, a launch inside a longer command or
  multiline block, reprinted or reflowed lines and a hired session resumed by
  hand, including while the agent waits on input. (As first merged, the
  waiting rows came from the screen through the cut, and a suspend, shell
  work and `fg` after an earlier read showed that shell work above the
  menu; independent review found it, and the rows now come from the
  session.) The cost: for an agent the owner started, a connected app sees
  the call a permission prompt is about but not the prompt's own rows, and
  a menu the harness doesn't record in its session can't be read; it can
  still answer it, keying an option by its digit, with `expect` set to text
  from the call (a command's first words) or the harness's own question. A
  Claude Code or Codex agent whose transcript can't be found is now
  unreadable instead of read from its screen, and when it isn't waiting on
  input a read shows only what it wrote to its session, not its live screen.
  The gaps below remain for other harnesses.
- An owner-started Claude Code or Codex agent in the desktop app's terminals
  is read from the session its harness's own files name for its process
  (#530), and the read's note says only that.
  - Codex's claim is bound to the process: the process itself holds that
    rollout open for writing.
  - Claude Code's is not. Claude Code holds no file open that would tie a
    session to its process (checked on 2.1.316), and a resumed session's
    first entries predate the process, so no entry time can either. The
    lifetime checks above stop a record left by an earlier process on the pid,
    but anything running as the owner can write a `sessions/<pid>.json` for a
    live Claude process, with the right `procStart` and `startedAt` and a
    session id of its choosing.
  - **Accepted exception (lead, on review of #744):** such a forged record can
    point the read at another of the owner's own Claude Code transcripts, one
    the harness's lookup finds as a regular, owner-owned file at its canonical
    path in the owner's Claude homes, and only that. It can't point the read at
    the owner's shell or screen, a symlink, or a file outside those homes. It is
    accepted because a writer with the owner's account can already read those
    transcripts directly. It is the same trust Herdr panes place in a session
    their hook reports.
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
  same pane, keeps the cut. Amended 2026-11-03 (#328): only while the hired
  agent is the pane's root process, launched as its command with no shell
  under it. A hire run under a shell (`herdr agent start` needs a shell
  prompt, so that is the usual Herdr hire), or a hired session the owner
  resumed by hand in their shell, can be suspended into that shell and
  brought back with `fg`, so it keeps the cut like an agent the owner
  started: a quiet one's first read is empty, with the held-back note, until
  it prints again. A root process that isn't named as a shell is taken for
  the agent, so a wrapper launched as the pane's command (`nix develop`,
  `direnv exec`, `script`) that runs the agent under it counts as root too;
  such a wrapper gives the owner no prompt to type at, but a wrapper that
  does would be read whole.
