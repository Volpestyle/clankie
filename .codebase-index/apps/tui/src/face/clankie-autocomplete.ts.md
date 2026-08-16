# apps/tui/src/face/clankie-autocomplete.ts

Slash-command and skill autocomplete/inspection. `createClankieAutocompleteProvider()` wraps Pi TUI completion: command arguments and discovered `/skill` names use static/dynamic catalogs, while ordinary input falls through to file-path completion.

Pure helpers power inline typeahead and the workbench: fuzzy search/list/detail, exact command resolution, append-only completion, argument parsing and warnings/examples. Suggestions are bounded and injected service/MCP/skill name listers keep the renderer independent of discovery.
