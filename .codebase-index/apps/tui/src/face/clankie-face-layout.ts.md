# apps/tui/src/face/clankie-face-layout.ts

Pure layout math for the face's band stack — no
rendering, fully unit-tested. Row budgets:
`resolveClankieTranscriptRows` (transcript gets all
spare rows, shrinking below its preferred minimum on
short terminals but never below 1) and
`resolveClankieCommandRows` (typeahead clamped to
its budget).

Mouse-target resolution maps absolute 1-based
terminal cells onto bands:
`resolveClankieTranscriptMouseTargetFromBands` and
`resolveClankieChromeMouseTargetFromBands` work over
an ordered `ClankieFaceBandRows[]` (banner /
transcript / status / typeahead / editor / modal),
returning row/col plus whether the cell fell inside;
overlay variants (`resolveClankieOverlayFrame`,
`resolveClankieOverlayMouseTarget`) do the same for
anchored modal frames.
