# apps/tui/src/shell/shell.ts

`ClankieFaceShell` — the face's owner. Assembles
banner, transcript viewport, status bar, editor, and
command typeahead into the pi-tui fullscreen
differential-render layout, and runs the central
input router: slash commands, plain prompts
(delegated to `onPrompt`), the `!` inline bash
escape, Ctrl+/ workbench, Ctrl+T transcript focus,
Esc detach/cancel, SGR mouse events fanned out to
transcript selection, scrollbar drags, chrome
selection, and click-collapse.

Key surface (used by every command):
`insertMarkdown`, `insertCommandResult`/
`insertCommandComponent`, `clearTranscript`,
`refreshStatus`/`refreshStatusView`,
`setBannerFields`, layout setters
(`setLayoutSettings`, `setHeaderVisible`,
`setSpinner`, `setSpinnerCycleRateMs`), the turn
loader (`startTurnLoader`/`stopTurnLoader`),
`setupFlow`, `showSelectableOverlay`,
`requestRender`, `shutdown`, and `restoreTerminal`
(disables SGR mouse tracking — the crash-safety hook
index.ts relies on).

Notes: `FaceShellCommand` is the command contract;
`interruptMode: "detach"` makes Esc abort observation
without cancelling the durable server turn, keeping
the prompt restorable; mouse tracking uses mode
1002+1006; layout defaults seed from `CLANKIE_TUI_*`
env; prompt history persists via prompt-history.ts.
