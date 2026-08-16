# apps/clankie/src/captain/captain.ts

`createCaptain(deps, options)` builds Pi sessions behind `CaptainPort`: durable operator and voice lanes, one-shot Discord text sessions, owner-authored persona/settings, skill discovery, trusted episodic recall, and authored/browser/connection tools.

Operator runs publish redacted bounded tool arguments/results, named skill lifecycle, context usage, and replies into the durable conversation store. A Herdr-hosted turn carries its pane/census; exact slash-skill invocations translate to Pi's skill syntax.

`runDurableTurn()` steers concurrent voice into the active Pi run and makes absorbed callers silent; `runOneShotDiscordTurn()` enforces a ten-minute outer deadline. Pi system tools are available to operator sessions and allowlisted system-actor Discord text only; voice and ordinary Discord remain on custom tools. Every settled heard/said pair lands in `LaneLog`, media stays turn-scoped, and `close()` waits for active work.
