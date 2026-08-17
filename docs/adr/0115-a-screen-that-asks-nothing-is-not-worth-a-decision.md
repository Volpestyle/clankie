# ADR 0115: A screen that asks nothing is not worth a decision

Status: accepted (2026-08-16). Follows
[ADR 0110](0110-an-undecoded-screen-is-a-fact-not-an-alarm.md), which stopped a
mind re-deriving "the decoder is broken" on every intro turn. That worked; this
decides what the same turns should cost once he is calm about them.

## Context

On 2026-08-17 Clankie booted FireRed in the hosted world and spent 13 turns and
4m38s without leaving the opening tutorial. ADR 0110's effect is visible in the
journal — he never once accused the decoder — and the run was still slow, for
three reasons the prompt itself supplied.

**He pressed A once per page.** Turn 0: _"Instructions say A only until a real
scene shows up. Pressing A."_ Every later A turn is a single press. The FRLG
opening is roughly twenty pages, and a turn is a vision-model round trip of
20–40 seconds, so the opening cost him minutes of wall clock before the game
began. `repeat` — up to 16 presses in one action, comfortably inside the
free-play budget of 64 inputs and 1800 frames — was documented only as the way
to cross a corridor without spending a decision per tile, so he used it for
movement and never for text. He reached for it exactly once all run, for B.

**He believed the tutorial was his own mistake.** Turn 3: _"The instructions
said L/R opens HELP and START can detour onto it, and B closes it. I must have
hit one of those somehow."_ He then spent two turns pressing B at a screen B
does not close, and wrote _"Accidentally opened HELP from the title screen"_
into his notes, where it rode along for the remaining nine turns. The prompt
said HELP twice: once as something START/L/R can detour him onto, and once as
a Bag menu that B closes. FRLG's new file opens with a mandatory HELP-system
tutorial, so both statements pointed at the screen he was on and both were
wrong about it.

**He reached for a helper the screen refuses.** Turn 9: `advance_dialog` on a
text box, rejected `semantic_state_unavailable`. The prompt said the decoded
helpers "will refuse until that cartridge has a verified state profile" — but
the refusal is per screen (`mode === "unknown"`), not per cartridge, and FireRed
has a profile. ADR 0110 corrected exactly this framing in the refusal hint and
left it standing in the system prompt.

Separately, the advice ADR 0110 added was unreachable on the local body.
`heldScreenAdvice` gated it on `danger.stateCertain === false`, and the two
bodies do not mean the same thing by that field: the hosted world publishes
false for a screen that does not decode, while the local adapter publishes its
evidence-chain integrity and stays true right through a boot. ADR 0110 called
`stateCertain` "the signal both readers use"; it is not.

## Decision

**A run of screens that asks him nothing costs one decision, not one each.**
Both the system prompt and `heldScreenAdvice` now name `repeat` as the way
through boot, the title, and a new file's tutorial pages. The count stays his:
a burst is blind — he sees only the screen it ends on — and the prompt says so,
so he sizes it to how far he is willing to go without looking. Nothing here
picks a number for him, because overshooting lands on the first screen that
does ask something, and that screen is his to answer.

**The opening is the game's, not a detour he took.** The prompt no longer warns
that START, L, and R can open HELP. It states instead that boot, title, and
tutorial screens are the game's own opening, that A advances them, and that B
does not leave them. The Bag's HELP system keeps its B advice, scoped to the
case that can be told apart from the outside: when the menu view actually names
`menuId: help-system`. An undecoded screen has no menu view, so the two can no
longer be confused for each other.

**A refusal describes the screen, in the prompt as well as the hint.** The
system prompt now says the decoded helpers refuse on a screen that does not
decode and work again on the next one that does, and `advance_dialog`'s
recommendation is conditioned on the scene decoding. ADR 0110 fixed the hint;
this fixes the sentence that taught the belief in the first place.

**"Nothing decodes" is the scene's mode, asked directly.** `heldScreenAdvice`
branches on `mode === "unknown"` rather than on `stateCertain`. The question it
asks is a property of the screen, and the scene observation is where that lives
on both bodies. `stateCertain` is still read for the screen that decodes but
carries no position — the one question both bodies do answer the same way.

## Consequences

The prompt no longer contains a statement contradicted by another statement in
the same prompt, which is what the journal shows him quoting back before each
wasted turn. The three defects were all cases of the harness asserting
something false with confidence, so the change is subtractive: the fix is
removing the false sentences, not adding advice on top of them.

The local body gains the ADR 0110 advice it never rendered. No deterministic
scenario changes: `stateCertain` keeps its per-body meaning and the scripted
driver still halts on it (`driver.ts`), which is why the divergence is resolved
at the reader rather than by making the local adapter report a boot as
uncertain.

A burst can overshoot a choice — sixteen A presses through the tutorial reach
the boy/girl question and answer it. That is the cost of the coarser
granularity, it is his to manage with the count he picks, and it is cheaper
than the minutes the one-page-per-turn loop spent.
