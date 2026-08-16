# apps/tui/src/face/clankie-transcript-viewport.ts

`ClankieTranscriptViewport` — the scrollback band:
an ordered list of block components (each with an
id, optional collapse/click-toggle, optional
bottom-pin) flattened into lines with configurable
block spacing, windowed to the viewport, with
wheel/page scrolling, drag text selection (inverse
highlight, extraction for copy), click-to-collapse
blocks, and an opt-in one-column proportional
scrollbar gutter (unicode block glyphs or ASCII;
dropped under 8 columns).

Blocks are managed through
`ClankieTranscriptBlockHandle`
(remove/setCollapsed/scrollIntoView). Also exports
the input classifiers the shell's router uses
(`isClankieSgrMouseInput`,
`isClankieTranscriptMouseScrollInput`,
`isClankieTranscriptPageScrollInput`) and the
scrollbar math helpers
(`computeClankieScrollbarColumn`,
`clankieScrollbarWindowStartForRow`). Underfilled
content can align top or bottom.
