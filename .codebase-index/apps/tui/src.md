# apps/tui/src

Fullscreen operator-console implementation: slash commands and typeahead, guided configuration flows, server-owned conversations, lane observation, presence/Herdr views, and layout-aware shell rendering.

- `activity-command.ts` — current gameplay activity formatting.
- `commands.ts` — core console command catalog.
- `connect-commands.ts` — service connection wizards.
- `discord-commands.ts` — Discord setup and status flow.
- `face/` — terminal components, editor interactions, and layout helpers.
- `index.ts` — face composition and startup.
- `memory-commands.ts` — memory inspection commands.
- `observation/` — presence, Herdr roster, and companion board observers.
- `persona-commands.ts` — owner persona setup.
- `provider-commands.ts` — model/provider setup.
- `session/` — conversations, lane tails, and Herdr reporting.
- `shell/` — TUI shell, status, prompt flows, history, and theme.
- `skill-catalog.ts` — visible skill discovery.
- `voice-commands.ts` — voice provider configuration.
