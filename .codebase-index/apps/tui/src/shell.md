# apps/tui/src/shell

Fullscreen shell composition, prompt/history state, status rendering, settings, and theme. It owns transcript/editor focus and layout while setup flows surface compact status updates instead of injecting their own result-output channel.

- `command-log.ts` — command transcript records.
- `face-settings.ts` — input/status placement settings.
- `prompt-history.ts` — persisted prompt history.
- `setup-flow.ts` — renderer-neutral guided wizard controller.
- `shell.ts` — complete TUI component assembly and event loop.
- `status-bar.ts` — bounded multi-row status component and context formatting.
- `theme.ts` — terminal theme construction.
