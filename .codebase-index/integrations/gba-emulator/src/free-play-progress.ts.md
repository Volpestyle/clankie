# integrations/gba-emulator/src/free-play-progress.ts

Turns "the adapter took the button" into what
actually happened, and measures whether the
playthrough is getting anywhere.
`observeEffect` diffs observations around an
action into a bounded human-readable summary —
this line is what the model is told.

Per-action describers use the adapter's own
outcome where a diff cannot see it: dialog
transcripts (oldest boxes dropped first),
walk results (arrived / warped / blocked by an
NPC, battle, or transition),
enter_text and select_menu_entry endings. A
short directional tap that only turned the
character is reported as a turn, not a wall
(which would poison refusal memory); presses
inside an open menu are never judged as
walking; the frame digest gets the last word
("screen changed — trust the frame" vs "no
visible change").

Unlisted dialog choices produce an explicit hint
to inspect the frame and press directly instead of
letting `advance_dialog` answer a prompt.

`FreePlayProgressTracker` keeps distinct tiles
stood on, map order, turns since a new tile,
actions per new tile, and per-tile refusal
memory (`refusedFrom` — memory of what he
tried, never a route). Helpers: `positionOf`,
`facingOf`, `attemptedDirection`,
`transitionKey`.
