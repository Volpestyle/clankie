# integrations/minecraft-mineflayer/src/motor.ts

The `MineflayerMotor` interface — the entire
surface the adapter drives: connection state,
presence/inventory/entities/recentChat reads,
abortable navigate/collect/craft/place/wait
actions, cancelCurrent, and stop. Plus
`MineflayerMotorFactory.connect`. Tests
implement a fake motor against exactly this;
`real-motor.ts` implements it with Mineflayer.
