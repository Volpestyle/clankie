# Getting a cold FireRed body to the overworld

**A fresh join starts at the intro, every time**, unless the game was saved
_in-game_. The host restores a cartridge save; walking around does not write
one, so the position a previous run reached is not where the next run begins.
Budget for the intro rather than assuming a resume.

**Press A, and only A.** `start` during the intro and naming screens navigates
away and the sequence never completes. An `a`/`start`/`a` loop ran 1,085 actions
to frame 62,000 — seventeen emulated minutes — without ever reaching the
overworld; A alone gets there in about 83 presses (~frame 7,900). This is the
concrete case of the fixed-button-loop warning in the skill.

**Diagnose unpaced, judge paced.** `WORLD_PACE=0` runs flat out, so "is this
stuck or just slow?" resolves in seconds instead of minutes. Probe the raw
world with `play.observe` and log `scene.mode` after each press: a plateau names
the screen you are stuck on. Then take the actual verdict at `WORLD_PACE=1`,
because pacing is what a watcher sees and what frame delivery is measured under.

**Do not "just check" a running session with a stop or a changed join.** An
exact join retry reuses the live body, but an explicit operator stop ends it and
a join with a different fingerprint replaces it. Use an isolated holder/world
for intrusive probes. To watch the default player's live session, tail its
journal instead — one JSON line per action with the frame number, under
`$WORLD_STATE_DIR/players/<hash>/games/<game>/journal/`.

Start the paced host and provision credentials as in
[the skill's hosted FireRed proof](../SKILL.md#hosted-firered-proof).
