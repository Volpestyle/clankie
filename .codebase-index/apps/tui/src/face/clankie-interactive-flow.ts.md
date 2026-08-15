# apps/tui/src/face/clankie-interactive-flow.ts

The modal prompt components SetupFlow renders as
centered overlays. `InteractiveTextPrompt` — single
text input with placeholder, validation error line,
and a `sensitive` mode that masks input and clears
the buffer on submit/cancel so secrets never linger.
`InteractiveSelectPrompt` — single/multi select with
type-to-filter, hints and descriptions, optional
status actions (e.g. "refresh registry"), a current
value marker, and back/cancel handling; shows up to
12 options with scroll info.

Both are pi-tui `Component + Focusable` with
callback-style `onSubmit`/`onCancel`/`onRender`.
Message titles get acronym-aware title casing
(API, MCP, OpenAI, xAI, …); frames come from
`renderClankieOutline`.
