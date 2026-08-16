# apps/tui/src/activity-command.ts

Formatter behind `/activity`:
`formatActivityObservation` renders the bounded
semantic projection of what Clankie is playing —
not_playing / pending / playing — labelling
model-authored fields (goal, commentary, intent)
separately from runner-observed ones (outcome,
effect, tile/map exploration, pace), plus the watch
URL.

Every model-authored string passes through `safe()`,
which strips all C0/C1 control characters: model
output is data, never terminal control sequences.
`ActivityObservationClient` is the one-method
interface the command needs from the api client.
