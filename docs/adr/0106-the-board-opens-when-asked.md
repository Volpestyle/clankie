# ADR 0106: The board opens when asked

Status: accepted (James, 2026-08-16). Amends the second decision of
[ADR 0097](0097-herdr-lead-is-the-companion-dashboard.md) — the console no
longer opens the board beside itself. The rest of that record stands: the
board is still the companion dashboard, joining a herdr session is still how
he acquires the fleet, and bare `herdr-lead` is still forbidden from his shell.

## Context

ADR 0097 had starting the operator console call `herdr-lead split`, so the
board appeared next to the conversation without being asked for. The intent
was that the seat and its dashboard arrive together.

Starting the console and wanting the board are different intents. The console
is opened constantly — to check presence, switch a conversation, run `/model`,
type one prompt — and most of those turns have nothing to do with leading a
fleet. Splitting a pane on every one of them spends the operator's layout on a
guess about what they came to do, and the guess is usually wrong. A companion
that has to be closed is worse than one that has to be opened.

Nothing about the board itself was the problem, which is why this amends one
paragraph rather than replacing the record.

## Decision

**The console never opens the board. `/board` does.**

`/board` opens, `/board focus` jumps, `/board close` closes — unchanged, still
idempotent, still one board per session, still setting `HERD_LEAD_TARGET` to
the console pane so jump-back lands on Clankie. Outside herdr they remain
no-ops.

The startup notice keeps advertising `/board`, so the affordance is still
discoverable from a cold console.

## Consequences

- Starting the console costs one pane, not two. Operators who want the board
  ask for it, and the ask is one command.
- A seated turn still receives the live `herdr agent list` census through
  `<herdr_session>`. Leading the fleet never depended on the board being open;
  it depends on the console being a herdr pane, which is untouched.
- `ensureHerdLeadCompanion` now has exactly one caller, `/board`. It keeps the
  skipped/unavailable outcomes because the command still runs outside herdr.
