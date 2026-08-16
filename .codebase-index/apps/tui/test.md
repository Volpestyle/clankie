# apps/tui/test

Vitest suites, one per module cluster, all
deterministic and TTY-free (fake shells, in-memory
credential stores, ephemeral HTTP servers, injected
spawn/kill/fetch seams, temp dirs cleaned in
afterEach).

- Face components: `banner`, `agent-spinners`,
  `autocomplete` (provider + typeahead + workbench),
  `interactive-flow`, `transcript-block`,
  `transcript-viewport`, `transcript-key-routing`,
  `face-layout`, `face-bash`.
- Shell: `shell-assembly` (constructs the shell
  without starting it), `status-bar`.
- Commands: `activity-command`, `discord-commands`,
  `provider-commands`, `voice-commands`.
- bin: `headless-captain` (health/restart/down over
  seams), `services` (supervisor + registry,
  ownership and probe semantics), `pairing`,
  `devices`, `trace` (cursor stores, redaction,
  stream processing).
- Session/observation: `operator-conversations`
  (stores, session, renderer, real HTTP round
  trips), `lane-observation`, `herdr-roster`.
