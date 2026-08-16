# apps/tui/bin/headless-captain.ts

Implements the complete headless `clankie` command surface: health/status, dependency-ordered restart/down, QR pairing, device list/revoke, operator credential rotation, and play status/stop. Restarts requested from an active Pi turn are deferred through the durable conversation event log.
