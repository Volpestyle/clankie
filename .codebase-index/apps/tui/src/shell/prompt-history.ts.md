# apps/tui/src/shell/prompt-history.ts

Prompt history for the editor: one JSON-encoded
prompt per line so multi-line prompts round-trip.
`readPromptHistory` returns the last 200 valid
entries, skipping corrupt lines; `appendPromptHistory`
mkdir-and-appends. Both are best-effort — history
must never break the face.
