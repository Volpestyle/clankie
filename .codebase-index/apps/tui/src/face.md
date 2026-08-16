# apps/tui/src/face

Terminal-face components for autocomplete, banner/chrome, clipboard and bash seams, responsive bands, prompt overlays, transcript rendering/navigation, mouse routing, and themes. Layout is computed from explicit screen bands and uses a fixed lightweight busy indicator rather than a configurable spinner catalog.

- `clankie-autocomplete.ts` — slash-command and argument completion/workbench.
- `clankie-banner.ts` — pixel-art header.
- `clankie-chrome-selection.ts` — non-transcript selection handling.
- `clankie-clipboard.ts` — terminal clipboard integration.
- `clankie-command-ui.ts` — command-result terminal blocks.
- `clankie-face-bash.ts` — trusted local shell escape.
- `clankie-face-layout.ts` — responsive band and mouse geometry.
- `clankie-face-theme.ts` — colors and terminal capability theme.
- `clankie-interactive-flow.ts` — text and single-select wizard prompts.
- `clankie-outline.ts` — bordered panel rendering.
- `clankie-sgr-mouse.ts` — SGR mouse parsing.
- `clankie-transcript-block.ts` — transcript block presentation.
- `clankie-transcript-key-routing.ts` — transcript/editor keyboard routing.
- `clankie-transcript-viewport.ts` — scrolling, selection, and viewport state.
