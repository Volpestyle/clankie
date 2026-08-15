# apps/tui/src/face/clankie-face-theme.ts

The shared face palette and theme factories. One
semantic color set (accent, code, danger, dim, label,
link, selectedDescription, success, warning) defined
twice — truecolor RGB (warm accent `#FFC470`, dusty
neutrals) and a 256-color fallback — selected by
capability in `paintClankieFaceText`.

`createClankieFaceAnsiTheme` builds the
`ClankieFaceAnsiTheme` used everywhere (semantic
names plus legacy aliases: cyan→accent, blue→link,
green→success, red→danger, yellow→warning, and
bold/italic/underline attributes);
`createClankieFaceMarkdownTheme` derives the pi-tui
markdown palette from it. No color → identity
functions.
