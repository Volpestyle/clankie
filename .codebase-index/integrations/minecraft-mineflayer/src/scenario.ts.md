# integrations/minecraft-mineflayer/src/scenario.ts

The frozen collect-craft-place scenario.
`parseFrozenMinecraftScenario` reads the YAML
fixture (`FrozenMinecraftScenarioSchema`:
world, spawn, reset blocks, target cuboid,
minimum logs) and returns it with its SHA-256;
`minecraftScenarioSessionSpec` builds the
session spec (overworld only, 128-block
radius, all six capabilities).

`runFrozenCollectCraftPlace` dispatches the
four fixed actions — collect the logs, craft
planks, craft a crafting table, place it at
the target cuboid's center — through
`EnvironmentRuntime.startAction`, polling
`actionStatus` until each settles within its
bound, then captures final presence and
inventory into a
`FrozenMinecraftGameplayReceipt`. Success
authority stays with the external Paper
verifier; this receipt records what the body
did.
