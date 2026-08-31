# ADR 0149: His herdr session is chosen, not inherited

Status: accepted (James, 2026-08-30). Amends the fleet-acquisition story of
[ADR 0135](0135-a-herdr-seat-is-a-conversation.md): joining a pane is no
longer the only way he acquires the fleet. The seat itself is unchanged.

## Context

Which fleet Clankie leads was decided by two accidents of process environment,
and they could disagree:

- **The herdr CLI target.** Every herdr child the service spawns — the agent
  census, `terminal session observe`, completion watches, and his own bash —
  inherits the service's `HERDR_SOCKET_PATH`. A service launched by the
  supervisor got herdr's default session; a service launched from inside a
  herdr pane silently got whatever session that pane happened to be in.
- **The seat.** The operator console reports its own `HERDR_PANE_ID`, and only
  a seated turn attached a census. A console sitting in a non-default session
  produced a seat from session A stitched onto a census from session B — and
  with no console running at all he had no fleet, despite the service (his
  durable body, per the architecture) being fully alive and the sockets
  reachable.

The captain's shell had the same inherited-accident shape: every lane's
sessions ran in the repo root, which on a release install is an immutable
directory he has no business working in.

## Decision

The binding is owner-chosen configuration, resolved once at service startup.

- `herdr.session` in settings names the session he leads (default: `default`,
  herdr's own default session). The service resolves the name to that
  session's socket via `herdr session list --json` and pins
  `HERDR_SOCKET_PATH` for every child it spawns, after scrubbing whatever
  `HERDR_*` identity the process inherited from wherever it was launched. An
  unknown name logs a warning and leaves herdr's own default resolution; a
  missing CLI leaves the env scrubbed. `clankie herdr set --session NAME` is
  the writer.
- **Every operator turn may lead.** The census attaches to any operator turn
  whose pinned session answers, seated or not. A seated turn keeps the join
  framing ("that pane is you"); an unseated turn — the phone, the menu bar —
  leads the same session from the service body, with no pane marked as him. A
  turn with no live session carries no herdr preamble at all.
- `captain.workingDirectory` in settings names where his shell and sessions
  run when a conversation names no workspace (default: the operator's home
  directory, replacing the repo root). `clankie workdir set PATH` is the
  writer.

Both settings are read at startup; changing them takes
`clankie restart captain`, consistent with every other config write.

## Consequences

- Clankie leads his fleet with no TUI running: a phone turn carries the same
  census a seated turn does. Losing the console loses the seat, never the
  session.
- Moving him to another herdr session is one setting plus a captain restart —
  not relaunching his console somewhere else. A console sitting in a
  different session's pane still leads the configured session; the census
  simply marks no pane as him.
- His default shell home is the operator's home directory. Existing pi
  sessions keyed to the old repo-root cwd start fresh on first continuation
  after the change.
- The pin is startup-time, so a session created after boot cannot be chosen
  without a restart — accepted; sessions change rarely and the failure mode
  is the documented warning, not a wrong room.
