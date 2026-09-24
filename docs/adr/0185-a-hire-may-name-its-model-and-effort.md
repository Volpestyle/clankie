# ADR 0185: A hire may name its model and effort

Status: accepted (2026-11-24). Extends the hire contract of the app repo's
ADR 0013 ("compose is hiring"): `SpawnOperatorSeat` carries an optional
`model` and an optional `effort`, and the captain turns them into the
harness's own launch arguments.

## Context

The operator hires pi, claude, and codex seats from the compose page, and the
harness always launched with its own default model and default reasoning
effort. Some tasks want a specific pairing — a stronger model for work the
defaults fumble, a cheaper one with the effort turned down for a disposable
worker — and the only way to get one was to hire first and change settings
inside the TUI by hand, which a first message sent at spawn time races.

## Decision

**Model and effort are hire-time choices, spelled the harness's own way.**
Both are optional bounded strings on `SpawnOperatorSeat`; absent means the
harness default, which is what an unopinionated hire gets.

- **The captain maps them to argv, not config.** pi, claude, and codex all
  take `--model <value>`; for effort the flags differ — pi's `--thinking`,
  claude's `--effort`, and codex's `-c model_reasoning_effort="<level>"`
  (codex has no launch flag, and the quoted value is what its TOML-style
  `-c` parses). The choices ride the same `herdr agent start … --` argv as
  the claude seat channel. Nothing is written to any harness's persisted
  config, so one hire's pairing never leaks into the next hire or into a
  pane the operator started by hand.
- **A harness with no wired flag fails the hire typed.** `fleetSeatModelArgs`
  and `fleetSeatEffortArgs` return undefined for the other harnesses in the
  allowlist, and the spawn fails `harness_unavailable` before herdr is asked
  to start anything. The alternative — silently launching the default the
  operator did not pick — is the worse fault: a hire that reports success on
  different terms than it was asked for.
- **A bad spelling is `not_ready`.** Each harness validates its own model
  pattern and effort vocabulary (pi's levels are not claude's); a value it
  rejects keeps it from coming up, which herdr already reports as a start
  failure. The captain does not keep a model catalog or a level list per
  harness.
- **A move carries neither.** Herdr does not report which model or effort a
  running seat was launched with, so the re-hire of
  [ADR 0166](0166-a-seat-moves-by-being-hired-again.md) starts the harness
  defaults. Recording the launch pairing on the seat is a real feature if
  the operator ever wants moves to preserve it; it is not this one.

## Consequences

The compose page gains optional model and effort fields under Advanced, next
to the working directory. The protocol change is additive on a strict schema,
so an old app talking to a new captain simply never sends them, and a new app
talking to an old captain gets the ordinary invalid-request refusal rather
than a mislaunched agent.
