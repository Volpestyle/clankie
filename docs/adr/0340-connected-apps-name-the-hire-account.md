# ADR 0340: Connected apps name the hire account

Status: Accepted, 2026-11-01. James routed hires by account through the main
chat: use the main Max account fully by its reset, paced so it doesn't run dry,
put Codex Pro to real use, and use the second Max account (shared, with a later
reset) only as light overflow. Amends
[ADR 0301](0301-claude-reaches-the-fleet-through-a-narrow-connector.md); builds
on the account allocation in [docs/cli.md](../cli.md) (VUH-1974).

## Context

Clankie already chooses an account for every hire that names none: within the
harness, the usable account the owner has not held with the most spare
capacity per day, pace-aware. Explicit accounts and owner holds always win.
A connected app's `start_agent` could pick the harness but not the account, so
an app could never use an account the owner had set aside, even on purpose,
and could not pin a hire to the account the owner wants spent first.

## Decision

`start_agent` takes an optional `account`: a profile label exactly as
`fleet_capacity` names it for that machine and harness, never an email, home or
key.

- **Left out, nothing changes.** Clankie picks as it does for his own hires:
  most spare capacity, held accounts skipped.
- **Named, it is exact.** The hire uses that account or is refused with the
  reason; no other account is tried. A held account may be named, as an
  explicit hire of Clankie's may, so "light overflow only" is a hold plus an
  app naming it when it chooses to.
- The label is checked at the relay and the service (letters, digits, `.`,
  `_`, `-`); the account choice itself is the existing `chooseWorkerAccount`.

How an owner routes hires with this: hold the account kept for overflow
(`clankie accounts hold claude <label> --reason ...`) on each machine; automatic
Claude hires then go to the accounts left, by pace; apps start Codex hires with
`harness: codex`, and name the held account only as overflow.

## Consequences

An app can spend an account the owner held, but only by naming it on a hire,
and the hire's `accountChoice` and the fleet's usage show it. Older services
refuse the unknown field, so an app's named account fails closed there.
