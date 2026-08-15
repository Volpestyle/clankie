# apps/tui/src/shell/theme.ts

`createFaceThemeBundle(stream)` — the one place that
detects terminal capabilities and derives every theme
object the shell hands out: banner capabilities, the
`ClankieFaceAnsiTheme`, pi-tui select-list and editor
themes, the markdown theme, and the command-UI
theme. Mirrors the v1 face wiring.
