# docs/adr/0044-runner-owned-mineflayer-private-paper-gameplay.md

The Minecraft body: a trusted-process-owned
Mineflayer client against a loopback-only private
Paper server; a console-only Paper plugin verifier
alone emits success — the client can never report
its own victory.

Read for the interruptible-settlement pattern
(adapters return `{status: running, completion}`
so pause/cancel/lease-loss are never queued behind
pathfinding), the pinned versions (Mineflayer
4.37.1, Paper 1.21.11 build 132, SHA-256-checked
download, explicit EULA), and the bounds: loopback
hosts only, no combat, no chat, no auto-reconnect.
