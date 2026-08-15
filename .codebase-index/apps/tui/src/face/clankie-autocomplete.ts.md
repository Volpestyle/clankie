# apps/tui/src/face/clankie-autocomplete.ts

Slash-command autocomplete and inspection.
`createClankieAutocompleteProvider` wraps pi-tui's
`CombinedAutocompleteProvider`: `/`-prefixed input
gets command-argument suggestions (static per-command
specs plus dynamic items for mcp/auth/integrations
via injected name listers); everything else falls
through to file-path completion.

Also exports the pure helpers the command UI builds
on: `formatClankieCommandInspector` (live markdown
detail for the typed command),
`searchClankieCommands`/`listClankieCommands` (fuzzy
workbench rows), `describeClankieCommand` (valid next
args, examples, warnings), and
`clankieCommandCompletion`. Suggestions cap at 18.
