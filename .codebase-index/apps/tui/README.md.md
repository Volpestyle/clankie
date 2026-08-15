# apps/tui/README.md

Operator manual and architecture doc for the console.
Covers the launcher command set (`clankie`, `status`,
`restart`, `down`, `trace`, `pair`, `devices`,
`operator-credential rotate`, `play`), the supervised
local services and their dependency/restart order
(ADR 0055), the render-only `clankie trace` surface,
`/trace` lane watching (ADR 0083), the source layout,
and every face interaction (typeahead, Ctrl+/
workbench, `!` shell escape, Esc detach, mouse,
`/layout`, `/auth`–`/model` wizards).

Notable facts recorded here: one backend on port 4310
(`CLANKIE_CONTROL_PLANE_URL` overrides,
`CLANKIE_CAPTAIN_URL` is a legacy alias); the service
outlives an exiting face; OpenAI API-key vs
`openai-codex` subscription providers never share
credentials; conversation cursors are capability-like
0600 state excluded from support bundles.
