# packages/environment-runtime/src/runtime.ts

`EnvironmentRuntime` persists versioned session/lease/action state and serializes all mutations through one queue. It enforces one writer per character/world, register-before-dispatch idempotency, bounded action deadlines/retention, renewable lease lapses versus final revocation, pause/cancel/emergency stop, restart reattachment, secret redaction, and generic `environment.*` semantic events.
