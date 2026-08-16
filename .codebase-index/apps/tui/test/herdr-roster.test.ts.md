# apps/tui/test/herdr-roster.test.ts

`HerdrRoster`: inert outside HERDR_ENV=1, sibling
listing that excludes its own pane / agentless panes
/ `done` agents / wrong-workspace panes, unknown
status handling, and poll failures surfacing as a
roster error rather than a silently empty list.
