# apps/tui/src/observation/herd-lead-companion.ts

Manages the `Herd Lead` companion pane beside a Clankie console. `ensureHerdLeadCompanion`, `focusHerdLeadCompanion`, and `closeHerdLeadCompanion` drive Herdr through an injectable runner, inherit an existing labelled board, and remain inert outside `HERDR_ENV=1`.

`formatHerdLeadCompanionResult()` turns opened/inherited/unavailable outcomes into operator-facing text.
