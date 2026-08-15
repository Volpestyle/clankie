# docs/adr/0072-the-harness-tells-him-the-truth.md

The honest-reporting principle for play: report
what the harness actually knows, in the line the
model reads, and say when the decoder is out of
its depth — born from a live run that spent half
its turns fighting fabricated effects.

Read for the seven fixes: a rejection becomes the
turn's effect ("rejected, nothing ran — reason")
with no state diff; `advance_dialog` handles
script-held screens and battle text; a `scene`
observation says who owns the screen; the frame
digest gets the last word and menus own the
d-pad; budgets sized for composite actions;
`walk_to` on the free-play wire; and `enter_text`
types a whole name in one verified action (19
model turns became one).
