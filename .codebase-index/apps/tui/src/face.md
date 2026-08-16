# apps/tui/src/face

The ported v1 face components (clankie snapshot
04734df9, VUH-755): everything that draws or parses
terminal I/O for the fullscreen face. Verbatim ports
— fix bugs upstream-style, don't restyle. All build
on `@earendil-works/pi-tui` primitives.

Children:

- `clankie-banner.ts` — welcome header + capability
  detection.
- `clankie-face-theme.ts` — shared palette, ANSI and
  markdown themes.
- `agent-spinners.ts` — 49-spinner catalog, presets,
  cycle/custom selections.
- `clankie-transcript-viewport.ts` — scrollback
  viewport: blocks, selection, scrollbar, mouse.
- `clankie-transcript-block.ts` — markdown block with
  tone-styled `**Title**` headers.
- `clankie-transcript-key-routing.ts` — when global
  keys route to the transcript.
- `clankie-command-ui.ts` — slash typeahead panel and
  Ctrl+/ fuzzy workbench.
- `clankie-autocomplete.ts` — slash-command
  autocomplete provider + command inspector/search.
- `clankie-interactive-flow.ts` — modal text/secret/
  select prompts for SetupFlow.
- `clankie-outline.ts` — box-drawing frame helper.
- `clankie-chrome-selection.ts` — drag-select over
  banner/status/typeahead/modal bands.
- `clankie-sgr-mouse.ts` — SGR mouse escape parser.
- `clankie-clipboard.ts` — OSC 52 + native clipboard
  copy.
- `clankie-face-bash.ts` — inline `!` shell escape
  runner and result block.
- `clankie-face-layout.ts` — pure row-budget and
  mouse-target math over band stacks.

Components are pure render(width) → lines objects;
the shell in `../shell/` owns focus, input routing,
and assembly.
