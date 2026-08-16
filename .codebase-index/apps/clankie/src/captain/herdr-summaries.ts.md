# apps/clankie/src/captain/herdr-summaries.ts

Maintains the small JSON file that associates Herdr pane ids with agent summaries and next actions. `herdrSummariesPath`, `readHerdrSummariesFile`, and `upsertHerdrSummaries` validate, merge, and atomically persist entries without dropping sibling panes.
