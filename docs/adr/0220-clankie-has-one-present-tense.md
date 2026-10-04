# ADR 0220: Clankie has one present tense

Status: accepted (James, 2026-10-04). Not yet implemented. Its first consumer is
the desktop pet in the private app (clankie-app ADR 0059, "Clankie lives on the
desktop"). The retired menu bar ([ADR 0125](0125-the-menu-bar-is-a-private-local-voice-room.md))
stays retired under [ADR 0203](0203-clankie-keeps-what-better-models-cannot-absorb.md).
Design and playable prototype: <https://claude.ai/artifact/HiRjtPWAjaqJLFGxo4doa3>.

## Context

What Clankie is doing right now is spread across separate reads: captain lanes,
Discord presence, live play activity, fleet seats and pending approvals. A
client that only wants to know whether he's thinking, talking, playing, leading
or waiting on the owner has to poll all of them. Some of those reads also don't
pass through the relay, so a remote or hosted client can't reach them.

The desktop pet needs exactly that answer, and so do the TUI header and
`clankie status`. The pet also needs a body that he can drive himself, plus art
that matches the logo.

## Decision

**One operator operation: `presence`.** It's a strict, cursor long-poll read
in `packages/protocol`, shaped like `fleet`. It returns:

- `mood`: `thinking`, `in_voice`, `playing`, `leading`, `needs_you` or `idle`
- a short `detail`
- `since`
- the active seat count
- the pending owner item, if there is one

The service derives it from the existing sources and adds no new state. It
joins the hosted operator allowlist, so device clients reach it through the
relay with their device bearer. The TUI and `clankie status` read it too.
"Unreachable" isn't a mood; a client infers it when the relay or service
doesn't answer, and has to show it differently from sleep. Sleep is the
client's own idle presentation of `idle`.

**A `desktop` tool for his volition.** It lets Clankie emote, move, or say a
line in a bubble on a desktop body when he decides to. It goes out through
`presence` as a transient expression. Clients show bubbles without taking
keyboard focus, let them fade, and respect owner quiet hours and macOS Focus.

**Hero art lives in `branding/pet/`.** The art is hand-authored pixel
animation on the logo's grid: idle, blink, glances, walking, hop, the sleep
cycle, think, talk, play, alert, happy, catch, offline, and worker minis with
a tint mask. It's built from editable text sources into an Aseprite-format sheet
with per-frame timings. Motion feel, such as the spinner easing in `think`, lives
in those timings, so every client plays it the same way. No frame comes from a
Codex pet.

## Alternatives

- **A separate HTTP presence route.** Rejected. It wouldn't reach hosted
  bodies through the relay, and it would split the operator contract.
- **A standalone Swift pet in this repo.** Rejected (James). The private app's
  macOS shell already has the chat, history, work and pairing UI the pet needs.

## Consequences

- `presence` reaches the private neighbors through `packages/protocol`.
- The pet only ships with the app. Public installs get the art and the
  operation, so any client can draw him.
- The app's Connect screen also moves to this art.
