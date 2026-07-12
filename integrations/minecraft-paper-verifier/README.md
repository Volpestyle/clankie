# Frozen Paper verifier

This integration is the independent source of truth for the first Minecraft
laboratory scenario. Paper owns observations and final state; Eve, Mineflayer,
and the gateway can request gameplay actions but cannot submit success.

```mermaid
flowchart LR
  A[Gameplay lane / Mineflayer] -->|ordinary survival actions| P[Private Paper server]
  C[Trusted server console] -->|reset · start · end| V[Verifier plugin]
  F[Frozen fixture embedded in JAR] --> V
  P -->|events + live world/player state| V
  V --> E[Bounded hash-chained events]
  V --> R[Hashed scenario report]
  R -->|validated adapter| I[@clankie/interactive-environment v1 event]
  A -. no criteria/result mutation tool .-> V
```

## Authority and failure behavior

- `mcscenario` is rejected unless the sender is the server console.
- The fixture hash is checked before compilation and again when the embedded
  resource loads. External fixture edits cannot change a running verifier.
- Reset validates the world seed, restores bounded blocks/target region, and
  normalizes the named player's survival state before hashing relevant state.
- Paper events record log collection, crafting, placement, death, commands,
  teleport, creative inventory, and game-mode changes. Event overflow fails
  closed instead of truncating a passing run.
- End reads the actual placed block, inventory, health, and game mode. Model or
  gateway reports are not inputs to evaluation.
- Each event links to the previous SHA-256. `report.json` and `events.jsonl`
  receive SHA-256 sidecars under the plugin data directory.

## Build and focused verification

The plugin pins Paper `1.21.11-R0.1-SNAPSHOT`, the final Paper line supported by
Java 21. The checked-in Gradle wrapper makes the build independent of a system
Gradle installation; both the distribution and wrapper JAR match Gradle's
published SHA-256 checksums.

```sh
pnpm --filter @clankie/minecraft-paper-verifier fixture:check
pnpm --filter @clankie/minecraft-paper-verifier test
pnpm --filter @clankie/minecraft-paper-verifier build
integrations/minecraft-paper-verifier/scripts/capture-evidence.sh
```

`scripts/run-lab.sh` starts a disposable local server only when the operator
supplies a trusted Paper 1.21.11 JAR and explicitly acknowledges the Minecraft
EULA. `scripts/reset-lab.sh` deletes only this package's `.lab` directory.

Server-console lifecycle:

```text
mcscenario reset
mcscenario start <run-id>
mcscenario status
mcscenario end <run-id>
```

Start/end are idempotent by run id. Reports live at
`plugins/ClankiePaperVerifier/runs/<run-id>/`. The integration adapter validates
their frozen scenario identity before emitting the existing v1
`minecraft.goal.verified` or `minecraft.goal.failed` semantic event.
