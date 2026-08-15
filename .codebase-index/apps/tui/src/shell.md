# apps/tui/src/shell

The face shell layer: assembles the ported face
components into the fullscreen layout and owns
everything stateful — input routing, overlays, the
wizard engine, the status bar, settings, and history.
Extracted from v1's `scripts/clankie.ts` monolith.

Children:

- `shell.ts` — `ClankieFaceShell`, the ~1300-line
  heart: layout assembly, central input router, turn
  loader, `!` bash mode, mouse plumbing, shutdown.
- `setup-flow.ts` — the SetupFlow wizard engine every
  configurator speaks (readText/readSecret/
  readSelect as modal overlays).
- `status-bar.ts` — the wrapped, capped status band +
  presence formatter.
- `command-log.ts` — `done /cmd command` transcript
  blocks for slash-command results.
- `face-settings.ts` — env/argument parsing for
  layout placement and spinner rate
  (`CLANKIE_TUI_*`).
- `prompt-history.ts` — best-effort JSONL prompt
  history (last 200).
- `theme.ts` — one place deriving every theme bundle
  from detected capabilities.

Commands and the entry point inject behavior through
`FaceShellOptions` (commands, onPrompt, statusExtras,
interruptMode), keeping the clankie service behind
its clients.
