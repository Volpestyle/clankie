# integrations/minecraft-mineflayer/test

Two suites:

- `adapter.test.ts` — the adapter and frozen
  scenario against a fake in-memory motor.
- `readiness.test.ts` — live-run preflight
  checks with a synthetic JDK and jar.
