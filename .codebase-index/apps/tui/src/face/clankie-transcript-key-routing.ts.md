# apps/tui/src/face/clankie-transcript-key-routing.ts

One predicate,
`shouldRouteClankieTranscriptGlobalInput`: decides
whether a global key/mouse event goes to the
transcript instead of the editor. Never while a
setup prompt or the command palette has focus; always
when the transcript is focused is excluded too (it
gets input directly). With an empty editor everything
routes; with a draft only page-scroll and
mouse-wheel inputs do, so typing never loses keys.
