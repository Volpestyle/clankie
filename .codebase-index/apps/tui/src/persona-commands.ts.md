# apps/tui/src/persona-commands.ts

`/persona` — edits who Clankie is, never what he may
do: free-text character notes (≤4000 chars), display
name and aliases (what counts as being addressed),
chattiness (quiet/balanced/chatty), and reply policy
(when addressed vs every message). All stored in
owner-authored `settings.json` via `SettingsStore`.

Exports `resolvePersonaText` (typed wins, blank keeps
existing) and `describePersona` for the status view.
Saves note that new Discord/voice turns pick changes
up (reply policy requires a bridge restart).
