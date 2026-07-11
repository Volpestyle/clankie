# Pi TUI command center

This app is built directly on `@earendil-works/pi-tui` from `earendil-works/pi/packages/tui`, pinned to `0.80.6` in this skeleton. It uses the package's `TUI`, `ProcessTerminal`, `Component`, `Editor`, `SettingsList`, overlays, key helpers, and differential renderer.

The TUI is a client of the semantic control plane. It must not become a second scheduler or infer authoritative task state by scraping terminal text.

Run after installing with Node 24:

```bash
pnpm --filter @sapling/tui dev
```
