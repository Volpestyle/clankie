# docs/adr/0066-dialog-is-one-action-not-one-press-per-box.md

`advance_dialog`: one catalogued action reads an
open conversation to its next real decision point
— stopping at a choice, a battle, or a closed box,
never answering a prompt. Termination is a
live-state question only the core can answer,
which is why it is an action, not a caller loop.

Read for the mechanics: while text prints it
advances frames with A held (FireRed's fast-read;
a held button can never register as the fresh
press a waiting box needs), terminal battle modes
count as readable while field input is locked,
the outcome carries a transcript of every box
read, and budget exhaustion is reported rather
than silently truncated.
