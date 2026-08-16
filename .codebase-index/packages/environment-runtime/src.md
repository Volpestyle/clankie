# packages/environment-runtime/src

Public entrypoint and durable implementation of the generic environment lifecycle. Concrete game-specific action/observation contracts remain in adapters and `@clankie/interactive-environment`.

- `index.ts` — runtime public exports.
- `runtime.ts` — lease, action, persistence, reconciliation, and event engine.
