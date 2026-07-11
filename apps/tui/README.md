# Pi TUI command center

This app is built directly on `@earendil-works/pi-tui` from `earendil-works/pi/packages/tui`, pinned to `0.80.6` in this skeleton. It uses the package's `TUI`, `ProcessTerminal`, `Component`, `Editor`, `SettingsList`, overlays, key helpers, and differential renderer.

The TUI is a client of the semantic control plane. It must not become a second scheduler or infer authoritative task state by scraping terminal text.

Run after installing with Node 24:

```bash
pnpm --filter @sapling/tui dev
```

The same executable has a non-interactive `--recovery-probe` mode for the M1
crash/reconnect gate. It reads mission state through `@sapling/api-client`,
consumes sequenced terminal replay from the runner semantic boundary, writes
an atomic cursor checkpoint, and remains alive so the drill can crash the real
TUI process. This is a CI proof surface, not an alternate operator interface.
