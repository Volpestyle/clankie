# apps/tui/src/face/clankie-chrome-selection.ts

Mouse text selection for the face's static chrome
(banner, status, typeahead, modal) — the transcript
band owns its own. Needed because SGR mouse tracking
suppresses the terminal's native drag-select.

`ClankieChromeSelection` tracks one selection scoped
to a single band per drag, captures each band's
rendered lines (ANSI-stripped) and paints an inverse
highlight over the selected columns;
`getSelectedText()` extracts the plain text for
copying. `ClankieChromeSelectableComponent` wraps any
chrome component to thread its render through the
controller while forwarding focus/input.
