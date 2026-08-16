# apps/tui

The `clankie` launcher, local service supervisor, and fullscreen operator console. Plain prompts use server-owned operator conversations; slash commands configure providers, connections, Discord, persona, voice, memory, traces, and the Herdr companion board.

- `bin/` — launcher, health-gated services, headless status/restart/down/trace/pair/device/play commands.
- `src/` — face shell, command catalogs, conversation clients, status observations, skill discovery.
- `test/` — deterministic TTY-free suites with injected process/network seams.
- `README.md`, `package.json`, `tsconfig.json` — operator guide and type-stripped runtime config.

Secrets go only to the credential broker; settings hold public configuration. Conversation events and replay cursors are service-owned or mode-0600 local checkpoints, and a Herdr-hosted console opens/inherits the labelled `Herd Lead` pane beside it.
