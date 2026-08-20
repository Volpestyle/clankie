# ADR 0072: The harness tells him the truth

Status: accepted (2026-07-27). Extends
[ADR 0049](0049-free-play-agency-and-non-deterministic-evidence.md) (free-play
agency), [ADR 0058](0058-read-collision-from-the-live-map-buffer.md) and
[ADR 0066](0066-dialog-is-one-action-not-one-press-per-box.md) (catalogued
composite actions), inside the authority bounds
[ADR 0053](0053-mcp-possession-of-clankies-body.md) sets.

## Current status (2026-08-19)

Truthful effects, observations, bounds, and composite actions remain shared
contracts. [ADR 0129](0129-each-player-owns-a-body.md) changes ownership only:
Clankie's runtime and every private GBA MCP runtime enforce those contracts on
independent bodies.

## Context

The harness must expose what it knows and avoid inventing effects when a decoder
is out of its depth. Four recurring failure shapes share this boundary:

- **Rejections need visible reasons.** The adapter's refusal reason belongs in
  the model-visible `effect`, not only journal `detail`. A rejected action has
  no state diff and must not produce a success-shaped sentence.
- **Script-held screens read as "no dialog".** During the starter fanfare the
  box is visibly on screen, but the field script parks on a wait native the
  dialog decoder does not model: mode reads "overworld", controls locked.
  `advance_dialog` is still the right choice. Battle text has the same shape
  under mode `battle`.
- **Undecoded screens can masquerade as the overworld.** Naming-screen input
  must not mint fake walls from stale overworld state or claim no visible change
  while the framebuffer changes.
- **The budget and the schema disagreed.** The prompt and action schema allow
  `repeat` up to 16; the free-play lease allowed 8 inputs per action. A
  legal-looking action is rejected whole, with the reason hidden (see above).

## Decision

One principle, applied at every seam: **report what the harness actually
knows, in the line the model actually reads — and when the decoder is out of
its depth, say that, rather than narrating a world outside its decoder.**

Concretely, in this wave:

1. **A rejection is the turn's effect.** When the adapter refuses an action,
   the effect line is `rejected, nothing ran — <reason>`, with the refusal
   codes a playthrough actually meets translated into play terms ("it asked
   for more button presses than one action may spend", "a script or fanfare is
   holding it"). The state diff is skipped entirely: diffing around an action
   that never ran is how the fabricated effects are made. Rejected turns are
   excluded from coherence scoring and refusal memory.
2. **`advance_dialog` enters the states he reaches for it in.** A held
   overworld screen (mode "overworld", field controls locked) is waited out,
   bounded, until the box becomes advanceable or the script releases — ending
   `script_released` / `script_holding` honestly when there is nothing to
   read. Battle text (mode "battle", input mode "resolving") is read like
   dialog, stopping at the action menu (`choice_open`) or the battle's end
   (`battle_ended`). Only a free screen with nothing readable still fails
   closed with `dialog_not_open`.
3. **A `scene` observation says who owns the screen.** `mode`, `inputReady`,
   and `waitingForDialogAdvance` are all decoded and all withheld. They are
   an observation on both the free-play view and the MCP surface — so "a
   script is running and the game is not taking field input" is one glance,
   not an inference from three misleading effect lines.
4. **The frame gets the last word, and menus own the d-pad.** `observeEffect`
   compares framebuffer digests around the action: "no visible change" is only
   claimed when the screen itself stood still, and a change the decoder cannot
   attribute says so ("screen changed … a detail the decoder does not model;
   trust the frame"). An open menu suppresses movement interpretation, so
   keyboard cursors stop minting fake walls. The naming screen is decoded as a
   menu (typed text, keyboard page, what is being named) instead of leaving
   the overworld to lie about it.
5. **The budget fits the vocabulary.** Free-play action limits are sized for
   the composite actions the catalog offers (`maxInputs: 64`,
   `maxFrames: 1800`): a 16-repeat press, a lab-length `walk_to`, and a
   monologue-length `advance_dialog` each fit one decision. `timeoutMs` stays
   at 5s deliberately — composite actions run synchronously and never meet
   it; it is the deadline that recovers a stalled `wait`.
6. **`walk_to` is offered, and narrated by its own account.** The action
   exists adapter-side, in the catalogue, and on the free-play wire. Its effect
   line comes from the route's outcome rather than a bare position diff. A
   verified NPC, battle, or transition is named; an unclassified route stop
   keeps its cause unknown and tells the player to check current occupants.

7. **`enter_text` types a whole name in one action.** The naming keyboard's
   RAM is probed and verified against the pinned core (cursor in gSprites
   slot 0, key grids per page, ring wraps, SELECT's input-eating page swap,
   START-to-OK, the close callback chain). The composite navigates by decoded
   cursor state, verifies every press's effect before the next, keeps a
   matching typed prefix and erases a wrong one (so a budget-interrupted
   entry resumes by repeating the same action), and stays inside verified
   territory: rows never wrap upward, the symbols page's unverified button
   strip is never used, and a wrongly-mapped transcribed key is caught by the
   typed-byte check and reported rather than confirmed. Real-core verification
   types and confirms "GASKET" in 26 presses and one action.

Two supporting fixes ride along: the Gen III accented charmap (the game spells
POKéMON with 0x1B; transcripts rendered it "POK�MON"), and honest dialog-effect
vocabulary for the new endings.

## Consequences

- The turn tax on scripted sequences collapses: the fanfare hold is one
  `advance_dialog` instead of six turns of experimentation; the battle intro
  reads in one action instead of refusing into `frame_advance` guesswork.
- Non-overworld screens cannot poison refusal memory, so
  route-around behaviour degrades only on real walls.
- A model that is told _why_ an action is refused can correct on the next
  turn instead of forming superstitions; the run archive keeps both the raw
  code (`detail`) and the played line (`effect`) for evaluation.
- The scripted dialog core in tests models held screens, timed releases, and
  battle text, so every new stop condition is a deterministic test rather
  than a live-ROM anecdote.
- `scene` is a new observation kind in the shared contracts; consumers that
  enumerate kinds pick it up from `GbaEmulatorObservationKindSchema`.
- A walk that stops because a battle or a fade started says so, and does not
  remember that tile as an NPC. An `advance_dialog` press that leaves the same
  box up, with no decoded menu, stops as `choice_unlisted` rather than burning
  the frame budget and inviting `select_menu_entry` on a menu that is not listed.

## Alternatives considered

- **Prompt him to distrust effect lines on undecoded screens.** Rejected:
  skepticism costs monologue every turn; the harness reports its limits instead.
- **Expose raw adapter error codes in the effect line.** Rejected: codes name
  implementation boundaries ("input_bound_exceeded"), not play advice; the
  journal keeps the code, the effect carries what to do about it.
- **Auto-detect and auto-clear script holds below the action layer.**
  Rejected for the same reason ADR 0066 rejected driver-side auto-advance: it
  would move a decision out of the catalogued, leased, refusable action set.
