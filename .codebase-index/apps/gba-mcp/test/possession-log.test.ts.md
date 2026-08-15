# apps/gba-mcp/test/possession-log.test.ts

Proves every lease transition lands durably
in `possession-events.jsonl`, not just on
stderr: a real `PossessionLease` wired the
way the entrypoint wires it produces the
full acquired/refused/released/expired/
stolen sequence with holder and reason
fields. Also proves an append failure is
reported through `onError` instead of
blocking the lease.
