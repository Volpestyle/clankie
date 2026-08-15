# apps/tui/src/face/agent-spinners.ts

The turn-loader spinner catalog: 49 non-emoji frame
sets ported from expo-agent-spinners (MIT), each with
its own interval. On top of the raw catalog sit
width presets (`width-1..4`), themed cycle presets
(`micro`, `needle`, `terminal`, `sweep-2`,
`pulse-3`, `ribbon-4`), a full `cycle` mode, and
`custom:<a,b,...>` selections.

`resolveAgentSpinner(value)` turns any selection
string into `{name, frames, intervalMs}` — cycles are
flattened into one padded frame list at a fixed 100ms
tick with a configurable per-style dwell (default
800ms). Normalizers accept underscores, `preset:`
prefixes, and `-only` suffixes. Default spinner is
`dots` (`rolling-line` when unicode is off).
