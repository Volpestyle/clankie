# @clankie/minecraft-mineflayer

Runner-owned Minecraft Java embodiment for the frozen private Paper laboratory
([ADR 0016](../../docs/adr/0016-versioned-interactive-environment-contract.md),
[ADR 0044](../../docs/adr/0044-runner-owned-mineflayer-private-paper-gameplay.md)).

`MineflayerMinecraftAdapter` sits behind `EnvironmentRuntime`; it never exposes
Mineflayer objects, server credentials, or verifier controls to a captain
lane. Long actions return an action handle immediately, and adapter completion
settles out of band so pause, cancellation, lease expiry, and emergency stop
remain available while pathfinding or digging is active.

## Boundary

- The server host must be the literal loopback address `127.0.0.1` or `::1`.
  There is no public-server capability or DNS-derived destination.
- Connection and account configuration is runner-private. Offline auth is
  accepted only as the explicitly labeled local laboratory mode. Microsoft
  auth uses an absolute runner-private Mineflayer profile cache; device codes,
  tokens, and paths never enter events or receipts.
- The only advertised motor capabilities are bounded observe, navigate,
  collect, craft, place, and wait. Combat, commands, public chat, verifier
  lifecycle, teleport, creative inventory, and public joins are absent.
- Navigation targets, dimensions, duration, radius, block changes, and
  capabilities are checked against the active runner lease before dispatch.
- Disconnect invalidates the adapter session. Reconnection creates a fresh
  governed session rather than silently reanimating a stale body.

`RealMineflayerMotor` pins Mineflayer `4.37.1` and
`mineflayer-pathfinder` `2.4.5` for Minecraft/Paper `1.21.11`. Its movements
disable digging, parkour, sprinting, and one-by-one towers; block changes occur
only in explicit collect/place actions. The frozen world is flat and its
controller does not depend on jump-over-block pathfinding.

## Frozen proof

The state-derived controller performs ordinary survival actions:

1. collect eight server-reset oak logs;
2. craft oak planks;
3. craft a crafting table;
4. place it inside the frozen target cuboid.

Mineflayer action completion is not success authority. The console-only Paper
verifier observes real server events and final state, then produces the only
accepted `minecraft.goal.verified` result.

```bash
# Downloads Paper 1.21.11 build 132 from PaperMC's immutable object URL and
# verifies the published size and SHA-256. It does not accept the EULA.
pnpm minecraft:paper:bootstrap

# Reports the exact remaining owner inputs without connecting.
pnpm minecraft:readiness

# Runs reconnect, gameplay, Paper verification, and emergency-stop proof.
MINECRAFT_EULA=TRUE \
CLANKIE_MINECRAFT_RECEIPT_DIR=/absolute/operator/evidence/path \
pnpm minecraft:live-proof
```

The live command builds the verifier with JDK 21, starts a disposable
loopback-only Paper server, writes no raw server output, validates both Paper
hash sidecars, and emits a mode-0600 content-bounded receipt. It refuses to run
without the exact pinned JAR and explicit EULA acknowledgement. An operator can
still override `PAPER_JAR`, but any override requires its own
`PAPER_JAR_SHA256`.

- `pnpm --filter @clankie/minecraft-mineflayer typecheck`
- `pnpm --filter @clankie/minecraft-mineflayer test`
- `pnpm --filter @clankie/minecraft-paper-verifier test`
