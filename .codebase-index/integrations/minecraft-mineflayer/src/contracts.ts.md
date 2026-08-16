# integrations/minecraft-mineflayer/src/contracts.ts

The package's contracts: the six-capability
enum (observe / navigate / collect / craft /
place / wait — nothing else exists),
`MINECRAFT_MINEFLAYER_VERSION` (1.21.11), and
`MineflayerConnectionConfigSchema` —
runner-private connection material that only
accepts literal loopback hosts, pairs
`offline_lab` auth with no profile path and
`microsoft` auth with a required absolute
runner-private profile cache. Also the motor
data types: presence, inventory slot, entity
summary, action outcome.
