# docs/adr/0092-a-repeat-that-changes-nothing-is-something-he-should-know.md

Free play tracks consecutive turns whose action
and bounded observed effect are both identical.
At `FREE_PLAY_REPEAT_TURNS = 3` the count reaches
the player's view, covering battle/menu/script
wedges where position-based stall signals vanish.

This is information, not an intervention: model
failures leave the count untouched and no action
is forced. The session result, journal summary,
and completion log expose the maximum as
`longestUnchangedRun` for later comparison.
