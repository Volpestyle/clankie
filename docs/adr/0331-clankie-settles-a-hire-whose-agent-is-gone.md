# ADR 0331: Clankie settles a hire whose agent is gone

Status: Accepted, 2026-11-01. The owner chose it after stuck desktop hires
fenced every place on the Mac. Amends VUH-2243's operator-only settlement;
extends ADR 0207 and ADR 0319.

## Context

A hire whose start never confirmed keeps an uncertain receipt, so a second
hire can't duplicate the first (ADR 0207). Until now only the owner could
settle one, with `clankie hire-receipt settle <id> abandoned`, which checks
this machine's complete inventory first: the original pane must be absent or
hold nothing but its shell. On the Mac, four desktop-app hires that had
already ended kept their places fenced until the owner settled each by hand,
and every new start there was refused in the meantime.

When the recorded pane is gone, or holds no harness, the first hire can't be
running, so a new hire can't duplicate it. The owner's step added nothing the
inventory hadn't already proved.

## Decision

- Before a new hire at a place on this machine (a Herdr pane or a desktop-app
  terminal), Clankie settles each unresolved earlier hire there whose recorded
  pane is absent from that runner's complete inventory or holds no harness,
  with the same census, double observation and evidence the operator's
  settlement takes.
- The recorded pane picks the inventory: a `herdr-core/` pane is checked
  against the desktop app's list, any other local pane against Herdr's. A pane
  on another machine is never settled this way.
- A hire still running, one with no recorded pane, a fresh intent, a remote
  hire, or one under operator recovery is left as it was; the owner's own
  settlement still covers those.
- Settling never closes, sends, relaunches or claims the brief arrived. The
  service log notes each one.

## Consequences

A place frees itself once its stuck hire's agent is gone, so leads and apps
stop seeing refusals that only the owner could clear. A launch that left no
pane record still waits for the owner, since the inventory can't rule it out.
