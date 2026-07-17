# ADR 0036: Terminal input authority is invisible; no user-facing takeover ceremony

Status: accepted (James, 2026-07-15).

Adopts [clankie-app ADR 0006](https://github.com/Volpestyle/clankie-app/blob/main/docs/adr/0006-terminal-input-without-authority-modes.md)
at the backend, protocol, and doctrine level for this repository.

## Context

The runner owns terminal sessions and must serialize writes — a PTY has exactly
one writer at a time — so the host holds one renewable, revocable, opaque control
grant per terminal ([ADR 0033](0033-terminal-wire-and-vt-restore-snapshots.md),
docs/05). That single-writer boundary is real safety and is not in question.

The v1 `clankies` app and this repository's early docs surfaced that grant as a
**user-facing ceremony**: observe-by-default, an explicit "take over" action to
acquire the lease, an owner/expiry pill, a renew button, and a hand-back gesture.
A 2026-07-14 UI-parity pass in clankie-app removed that ceremony (clankie-app
ADR 0006, superseding its ADR 0004): the terminal now presents one continuous
output surface with two peer input paths — tap the terminal to type directly, tap
the bottom composer for drafted input plus terminal keys — while the client
acquires the grant on foreground, auto-renews before expiry, releases on
background, and lazily reacquires before a write. The grant never becomes product
navigation, and grant tokens never enter view state.

The plan drifted from the shipped app. This repository's docs and several Linear
issues and milestone exit gates still describe the removed ceremony ("Human
takeover", "explicit control lease for takeover", "terminal takeover" gates) and
still couple worker steering to the terminal lease. That drift is corrected here
without weakening the host boundary.

## Decision

1. **The host grant stays unchanged.** One renewable, revocable, opaque control
   grant per terminal, attributed per principal/device/client-instance,
   deduplicated by operation, fail-closed — exactly as [ADR 0033](0033-terminal-wire-and-vt-restore-snapshots.md)
   and docs/05 specify. The security mechanism does not change.

2. **The grant is invisible transport authority, never a user-facing mode.**
   No surface exposes a "take over" action, mode toggle, owner pill, countdown,
   renew button, or hand-back gesture. Clients acquire, renew, and release the
   grant automatically. A contention or transport failure appears only as input
   availability, and the next terminal tap or send retries.

3. **Direct input is the default posture on capable authenticated clients**
   (macOS, iPhone, iPad): tap the terminal to type. "Observe-only" is a
   capability/scope restriction — an `observe`-scope credential, or a platform
   without a native emulator (Android, [clankie-app ADR 0001](https://github.com/Volpestyle/clankie-app/blob/main/docs/adr/0001-android-terminal-observation.md)) —
   not the default experience and not a mode the operator toggles.

4. **Worker steering is decoupled from the terminal grant.** Steering is a finite
   set of typed intents on the control plane ([ADR 0018](0018-captain-worker-control-parity.md)),
   not raw PTY bytes, and is never gated by who holds a terminal's write grant.
   The doctrine approval floor is unchanged: privileged or irreversible actions
   still require human approval on an authenticated surface ([ADR 0010](0010-embodied-teammate-persona-non-authority.md),
   `AGENTS.md`). Ambient channels keep steer/query/pause authority and never
   accept approvals.

## Consequences

- docs/05 "Human takeover" becomes "Terminal input authority": the runner still
  owns the single grant, but it is acquired invisibly by the operator's client;
  there is no explicit takeover/hand-back narrative.
- docs/03 build-plan, docs/12 release criteria, docs/00 product thesis, and
  docs/GLOSSARY drop "takeover" as the terminal-interaction verb in favor of
  direct input (tap to type); the control grant is described as host-owned and
  invisible.
- docs/06: selecting a worker is a read that opens its transcript; terminal input
  is direct; "Take over" / "Hand back" remain run-/fleet-level verbs, not a
  terminal-input ceremony.
- [ADR 0018](0018-captain-worker-control-parity.md) is amended: captain input and
  human input are both writers under the one grant, but the grant is acquired
  invisibly and steering is not gated by "acquiring a human control lease" — that
  clause is superseded here.
- One residual runner coupling remains: `apps/runner/src/mission-worker.ts`
  (`hasHumanControlLease` → `human_control_active`) still pauses captain steering
  while a human holds terminal control. Whether captain steering *should* pause
  while a human is hands-on the terminal is a behavior decision, not a naming one;
  it is tracked as follow-up rather than silently changed here.
- Analytics `terminal_takeover_started` / `terminal_takeover_ended` describe an
  event that no longer occurs; they are deprecated in favor of input-authority
  telemetry, with the schema change tracked separately (docs/09).
- The [terminal wire](0033-terminal-wire-and-vt-restore-snapshots.md) and the
  interactive-session lease ([ADR 0016](0016-versioned-interactive-environment-contract.md))
  are unchanged in mechanism and reframed only in user-facing narrative.

## Options weighed

Removing the host grant entirely (make every client a co-equal writer) was
rejected: it drops single-writer PTY safety, allows two writers to clobber a pane,
and diverges from what clankie-app shipped. Keeping the ceremony but "polishing"
it was rejected in clankie-app ADR 0006 — the ceremony competed with the two
choices the operator actually makes and made a normal terminal tap indirect. The
accepted path keeps the boundary and deletes only its user-facing surface.
