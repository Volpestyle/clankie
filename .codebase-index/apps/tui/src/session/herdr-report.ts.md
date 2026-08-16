# apps/tui/src/session/herdr-report.ts

Reports operator-console presence and display metadata through Herdr's socket CLI when the TUI occupies a Herdr pane. `herdrPaneIdFromEnv`, `reportHerdrAgent`, and `reportHerdrMetadata` are inert outside `HERDR_ENV=1`; production callers identify the source/agent as `clankie` and publish turn state plus the `Clankie` pane title.
