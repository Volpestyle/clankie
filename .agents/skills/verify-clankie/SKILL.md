---
name: verify-clankie
description: Use when validating a Clankie capability across a service, credential, emulator, ROM, or other runtime boundary, and when deciding what a green test actually proves before claiming the capability works.
---

# Verify Clankie

Match the evidence to the claim. A deterministic double proves client logic. It
does not prove that the real service boots, decodes, accepts the request, or
preserves state. Call a capability working only after exercising the public path
with the real dependency named in the claim.

## Proof ladder

Run all applicable rungs; a higher rung does not replace the lower ones.

1. Characterize the promised public boundary with a deterministic dependency.
   Cover every success, refusal, and stop branch there, not helper functions.
2. Run the repository gate (`pnpm check`). Record its exit code and confirm the
   new test appears in Vitest's **Test Files** output.
3. Drive the same public entry point the product uses against the real system.
   Do not substitute an in-process host call for a Unix-socket client, or a
   helper method for a captain tool/body seam.

Report advertised capabilities as `live`, `refused`, or `absent`. A receipt
that fails because a promised capability is absent is useful evidence; do not
weaken the expectation to make the instrument green.

## What a live proof must demonstrate

- Booting is not playing. Require a decoded observation and a meaningful state
  transition, then read the state again through the public path.
- For frames, count distinct framebuffer digests and logical-frame progress.
  Callback count alone can be repeated delivery of one frozen frame. Record
  gaps or dropped-frame counts too.
- Exercise identity, session, refusal, persistence, and cleanup paths when the
  claim includes them. Put leave/close in `finally` so a failed probe does not
  strand a body.
- Use semantic observations to steer scripted cartridge setup. Fixed button
  loops can reopen a menu or take a different branch and then misdiagnose the
  implementation under test.
- Preserve odd baseline behavior in characterization tests. Correct it later
  as a separately reviewed behavior change.

## Test discovery gotcha

Read the repo's root `vitest.config.ts` before deciding where a test belongs.
PokeAgents currently discovers both `<package>/test/**/*.test.ts` and co-located
`<package>/src/**/*.test.ts`; older revisions discovered only `test/`, so moving
a correctly co-located test based on memory just creates churn.

Confirm discovery by count, not by exit code. Note **Test Files** and **Tests**
before and after; if adding tests did not move both, they are not in the gate.

## Hosted FireRed proof

Start the real paced host from `~/dev/pokeagent-mmo`:

```bash
WORLD_STATE_DIR=~/.pokeagent-mmo/world \
WORLD_HOLDERS_FILE=~/.pokeagent-mmo/holders.json \
WORLD_ROM_DIR=~/.pokeagent-mmo/roms \
WORLD_PACE=1 \
pnpm --filter @pokeagent-mmo/world-server start
```

Provision credentials through the credential broker or a temporary injected
store; never add an environment-secret fallback or print the credential. Keep
ROMs, saves, RAM, screenshots, and cartridge-derived state out of the repo.
Receipts may contain schemas, logical observations, and SHA-256 digests.

`WORLD_HOLDERS_FILE` is not optional. Unset, the holder directory is empty and
identity is deny-by-default, so every join refuses `unauthenticated` — which
reads as a bad credential and is not one.

### Getting a cold body to the overworld

**A fresh join starts at the intro, every time**, unless the game was saved
_in-game_. The host restores a cartridge save; walking around does not write
one, so the position a previous run reached is not where the next run begins.
Budget for the intro rather than assuming a resume.

**Press A, and only A.** `start` during the intro and naming screens navigates
away and the sequence never completes. An `a`/`start`/`a` loop ran 1,085 actions
to frame 62,000 — seventeen emulated minutes — without ever reaching the
overworld; A alone gets there in about 83 presses (~frame 7,900). This is the
concrete case of the fixed-button-loop warning above, and it was written by the
same run that then fell into it.

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

A useful receipt names the code revision and artifact digests, the public path,
each advertised capability and outcome, exact check commands and exit codes,
and any unpinned input. Use `trace-clankie` afterward to correlate durable
runtime trails when the live result disagrees with the test.
