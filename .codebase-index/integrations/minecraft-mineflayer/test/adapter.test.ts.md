# integrations/minecraft-mineflayer/test/adapter.test.ts

Tests the adapter and frozen scenario with a
`FakeMotor` implementing the motor interface
in memory: binding and capability validation,
the async running-handle lifecycle, cancel and
timeout fencing, bounds refusals (radius,
quota, combat, dimension), observation shapes,
disconnect invalidation, and the full
`runFrozenCollectCraftPlace` receipt through a
real `EnvironmentRuntime`.
