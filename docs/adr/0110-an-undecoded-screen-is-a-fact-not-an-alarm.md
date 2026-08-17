# ADR 0109: An undecoded screen is a fact, not an alarm

Status: accepted (2026-08-16). Builds on
[ADR 0108](0108-the-effect-line-has-two-readers.md), which split the turn's
effect from the harness's coaching; this decides what the two of them may
claim when there is no decoded state to reason about. Also builds on
[ADR 0103](0103-a-hosted-world-is-another-body.md).

## Context

On 2026-08-16 Clankie played FireRed in a hosted pokeagent-mmo world and spent
five minutes on the intro without reaching the game. The play journal shows the
same conclusion re-derived every single turn:

- turn 0 — "State profile unverified so walk_to/advance_dialog/menus are off the
  table until that changes."
- turn 1 — "State profile unverified — buttons and frames only."
- turn 2 — "Scene still unknown so helpers are out."
- turn 6 — "Scene mode is still unknown so advance_dialog keeps no-oping."
- turn 7 — "State decoder is still dead so helpers won't help."

He was not confused about the game. He was correct about the game, every time,
and paid full price for the same sentence on every turn — writing it into
`notes`, into `monologue`, and then into the voice room, because `roomEvent()`
hands the effect line to the realtime model and the model speaks it. People in
the channel heard a decoder diagnosis instead of someone playing Pokémon.

Nothing in the turn carried the conclusion forward, and three separate signals
arrived each turn framed as a fresh anomaly:

- `danger` reported `severity: "high"`, `code: "uncertain_state"` for the length
  of a cutscene.
- The effect line said _screen changed though the decoded state did not —
  possibly ambient animation; trust the frame_, which reports a disagreement
  between a decode and a frame when only the frame existed.
- The refusal hint said _this cartridge has no decoded state profile yet_,
  describing a permanent defect of the cartridge.

None of that was true. The FRLG intro is an ordinary screen that carries no
position and no party. The only thing genuinely missing was a statement of what
reaches the controls, and with no statement the mind inferred one — repeatedly,
from a refusal, at the cost of a turn each time.

## Decision

**The harness states what reaches the controls; the mind never has to infer it.**
`heldScreenAdvice` already existed as the "what this screen means, do this"
channel, and already covered a battle waiting on input and a script-held
overworld. It gains the case that matters most: a screen with no decoded state
says so plainly, says it is normal on boot and intros, and names the actions
that will still run. Stated as a given, it is not rediscovered.

**An effect may not claim a disagreement it cannot have observed.** "The decoded
state did not change" is a comparison, and a comparison needs two sides. When
`danger.stateCertain` is false there is no decoded state to have stood still, so
the effect is _the screen changed_ — no anomaly framing, no advice. This is also
the line an audience hears (ADR 0108), which is the second reason it must not
read as a fault report.

**A refusal describes the screen, not the cartridge.**
`semantic_state_unavailable` now says this screen carries no decoded state, that
it is normal on intros and boot, and that the helpers return when a screen
decodes. The old wording described a defect with no end, so a mind stopped
reaching for helpers long after they started working.

**Uncertainty is not severity.** A hosted body reporting a screen it cannot
decode drops to `severity: "low"`. `stateCertain` stays false and stays the
load-bearing field — a scripted driver still halts on it — but a boot sequence
is no longer an alarm that rings for minutes.

**`danger.stateCertain` is the signal both readers use.** Both bodies publish
it: the local adapter from its own decode, the hosted world from the adapter
behind the socket. Reading it beats inferring absence from which observation
kinds happen to be missing, which is not the same question.

## Consequences

The complementary half is in pokeagent-mmo, not here: its FireRed adapter now
decodes the title screen, Oak's new-game speech and the help overlay instead of
returning `unknown` for all of them, so these screens arrive named. Both halves
are needed — this ADR keeps a mind calm about a screen nothing can decode; that
change shrinks the set of such screens.

What a calm mind then _costs_ on those screens is decided by
[ADR 0115](0115-a-screen-that-asks-nothing-is-not-worth-a-decision.md), which
also corrects the claim above that `stateCertain` is the signal both readers
use: the two bodies do not mean the same thing by it, so whether a screen
decodes is read from the scene's own `mode`.

Oak's speech decodes as `cutscene` rather than `dialog`, because it draws its
own text and the field message box reads zero throughout. `advance_dialog`
genuinely cannot read it, and a refusal that returns immediately is cheaper than
a helper that spends a turn discovering the same thing.
