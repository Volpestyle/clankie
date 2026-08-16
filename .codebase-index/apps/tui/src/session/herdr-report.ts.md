# apps/tui/src/session/herdr-report.ts

Self-reporting into a Herdr pane, inert outside
`HERDR_ENV=1` (and without `HERDR_PANE_ID`).
`reportHerdrAgent` runs `herdr pane report-agent`
with a state (idle/working/blocked/unknown) and
optional message; `reportHerdrMetadata` publishes
title/token via `report-metadata`. Both default the
source/agent to `clankie-trace` and accept an
injected command runner for tests. Used by
`clankie trace` so the pane shows trace status.
