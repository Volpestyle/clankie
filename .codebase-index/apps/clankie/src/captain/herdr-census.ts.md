# apps/clankie/src/captain/herdr-census.ts

Reads and formats the live Herdr agent roster for an operator turn seated in a Herdr pane. `parseHerdrAgentList`, `formatHerdrSessionCensus`, and `readHerdrSessionCensus` keep command execution injectable and fail soft when Herdr is unavailable.

Optional summaries from `herdr-summaries.ts` nest beneath their matching pane so Clankie sees both agent state and the durable handoff note.
