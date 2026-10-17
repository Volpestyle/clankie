# Managed Discord startup and recovery — VUH-1647

The existing runtime synchronizes the latest durable room policy after startup, an edge outage, and a body restart. The old local-stack fixture explicitly called `sync()`, which could hide a broken startup or periodic retry. The fixture now observes production startup, and recovery tests rely on the real five-second runtime retry.

## Observed

- Core: all five managed-Discord integration cases pass (restored-source run: 9.37 s). The new case saves two offline revisions, restarts the body, restores HTTP availability, and observes exactly one policy application for the newest room. A second body restart does not replay it.
- Negative control: replacing only the runtime retry callback with a no-op makes the new case fail at the policy revision poll (15 s). Restoring the original runtime bytes restores all five passes. Runtime source SHA-256: `781dc0862922d7d0ddc5ed3659e7e2f4643ec2861d7d9f3efce84624c3a197a4`.
- Ops: both browser builds and the fleet typecheck pass. All 19 cases across five affected integration files pass (13.67 s), including the explicitly enabled native Chrome desktop/phone journey.
- The new local-stack cases exercise encrypted owner directory/settings requests, permission-filtered named rooms, foreign-account refusal, startup policy acknowledgement, a real edge HTTP outage, a recreated body runtime, and reopened encrypted SQLite state. Recovery occurs without a browser refresh or explicit sync call; only the newest room grant advances the retained head once. Another edge restart preserves that head.
- Touched TypeScript files pass formatting and lint checks.

## Boundary and remaining gap

This is a loopback integration proof using real HTTP, JWT verification, encryption, gateway/body transport, the production retry loop, and SQLite. Discord's native cache, account identities, and external providers are disposable fixtures. Body restart recreates the application runtime; edge restart recreates its listener, edge object and SQLite handle. It is not a deployed process or real-provider proof.

No real tenant, installation, Discord account, or message was targeted. No shared service was restarted and no deployment occurred. Per the lead's scope, VUH-1647 stays open for deployed-edge verification after the managed edge deployment tracked with VUH-1765. That verification is agent work after deployment.

The retained packet includes source diffs, exact commands and outputs, the initial test-assumption correction, the expected negative-control failure, and restored positive results. Landing checks are reported on the issue with the final commit links.
