# packages/environment-runtime/README.md

Overview of the runtime's model: trusted command
boundary → EnvironmentRuntime → atomic lease +
action state, adapter, and semantic events
(mermaid flowchart included). States the
invariants — one unexpired writer lease per
character/world, credential-free durable records,
register-before-dispatch idempotency, restart
reconciliation, immediate invalidation on expiry/
revoke/emergency stop, and the semantic-plane
rule that raw packets/ticks travel only as opaque
`artifact://` telemetry references.
