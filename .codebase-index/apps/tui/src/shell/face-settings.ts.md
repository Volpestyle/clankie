# apps/tui/src/shell/face-settings.ts

Parsers for the face's layout preferences and their
env defaults: `parseInputPlacement` (top/bottom),
`parseStatusPlacement` (above/below input),
`parseAgentSpinnerCycleRateMs` (fast/normal/slow,
`400ms`, `1.2s`, or a raw integer), and
`layoutSettingsFromEnv` reading
`CLANKIE_TUI_INPUT_PLACEMENT` /
`CLANKIE_TUI_STATUS_PLACEMENT` (spinner env names
are also exported for shell.ts). Defaults: input at
the bottom, status above it.
