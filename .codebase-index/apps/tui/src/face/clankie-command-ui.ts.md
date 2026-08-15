# apps/tui/src/face/clankie-command-ui.ts

The two command-discovery surfaces. The typeahead:
`clankieCommandTypeaheadFor` derives prefix matches
from the editor text (preserving the previous
selection), with move/dismiss/selected helpers and
`ClankieCommandTypeaheadPanel` rendering up to 10
rows above the input. The workbench:
`ClankieCommandWorkbench` is the Ctrl+/ overlay — a
fuzzy-searchable command list with a detail pane,
built on the autocomplete module's search/describe
helpers and framed by `renderClankieOutline`.

Both consume `ClankieAutocompleteCommand` display
fields and a small injected theme; key handling uses
pi-tui `matchesKey`/kitty decoding.
