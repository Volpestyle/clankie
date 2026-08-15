# apps/tui/src/face/clankie-outline.ts

`renderClankieOutline(lines, width, border)` — wraps
lines in a single-line box (`┌─┐ │ │ └─┘`),
truncating and padding each row to the inner width
with ANSI-aware measurement. Used by the modal
prompts and the command workbench.
