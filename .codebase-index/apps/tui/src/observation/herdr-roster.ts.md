# apps/tui/src/observation/herdr-roster.ts

`HerdrRoster` — sibling agents in Herdr panes, read
from `herdr pane list` (workspace-scoped when
`HERDR_WORKSPACE_ID` is set) because Herdr-hosted
sessions are invisible to the clankie service: an
empty roster must mean "no one is working", never
"no visibility". Inert outside `HERDR_ENV=1`.

Parsing is defensive: excludes its own pane,
agentless panes, panes that cannot prove workspace
membership, and `done` agents (finished, not
mislabeled unknown); unknown statuses stay
`unknown`. Poll failures surface as a roster error
rather than a silently empty list.
