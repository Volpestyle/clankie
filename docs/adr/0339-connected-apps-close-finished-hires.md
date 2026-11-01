# ADR 0339: Connected apps close finished hires

Status: Accepted, 2026-11-01, on James's ask: "nah we need to be able to close
agents from here without me". Amends
[ADR 0301](0301-claude-reaches-the-fleet-through-a-narrow-connector.md) and
[ADR 0321](0321-the-roster-says-who-started-each-agent.md); keeps the unlanded-work hold
of `close_seat`.

## Context

A connected lead can start agents (`start_agent`), message them, read them and
press keys, but it couldn't close one. Finished hires piled up on the owner's
machines, and the only way to close them was James at the keyboard. Hiring a
worker to kill other panes isn't an answer: it puts a destructive brief into an
agent, and lead safety checks rightly refuse it.

## Decision

The connector gains `close_agent`, which rides the service's existing
`close_seat`.

- **Only Clankie's or an app's hires.** The relay stamps the connector device
  it authenticated onto `close_seat` (`appDeviceId`, refused when a caller sends
  it), and the service, seeing that stamp, closes only a seat whose hire record
  says Clankie or a connected app started it (ADR 0321's starter). A pane the
  owner started by hand, a hire the owner asked for, and a pane another agent
  started stay the owner's to close: `not_clankies_hire`.
- **Never mid-turn.** The seat must read `idle` or `done` in a fresh fleet
  read, and its terminal is read again right before the exit. Anything else is
  refused as `busy` with its status, and nothing is closed.
- **Unlanded work holds as before.** A worktree with unlanded work refuses the
  close and names the worktree. The app may close again with `leave_unlanded`,
  a reason recorded as left behind, exactly as the owner's `close_seat` does.
  The work stays on disk.
- **Watch still closes nothing** (ADR 0308).
- **Logged.** Every close an app asks, closed or refused, is logged as
  `connector.close_agent` with the app's device and the seat.
- **No focus.** Closing kills the pane or terminal; nothing brings a window
  forward.

Owner devices keep closing through `close_seat` unstamped, with only the
unlanded-work hold.

## Consequences

Connected leads can tidy up after their own workers without James. The owner's
own agents, and anything still working, can't be closed from an app. The grant
is the same steer grant that lets an app start agents, so no new pairing step
is needed.
