# apps/tui/src/shell/setup-flow.ts

`createSetupFlow(context)` — the guided-flow engine
every configurator wizard speaks: `begin`/`end`,
`renderLine`/`renderOutput`/`setStatus` (summarized
onto the status bar), `readText`, `readSecret`
(sensitive modal, validation-with-retry loop),
`readSelect`, and `waitForInterrupt` (for
cancellable OAuth waits). Each read renders an
InteractiveTextPrompt/InteractiveSelectPrompt as a
centered overlay; `undefined` means cancelled.

The controller adds shell-facing hooks:
`cancelActivePrompt`, `handleSubmit` (typing
`/cancel` aborts the active prompt), and
`isWaitingForInput`. The interface is deliberately
renderer-agnostic so a remote surface can serialize
the same flows later.
