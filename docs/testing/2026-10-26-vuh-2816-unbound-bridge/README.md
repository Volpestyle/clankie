# VUH-2816: the operator lane admits only the registered seat bridge

The service, not the bridge's environment or argv, decides who may act as the
lead. Design and limits: the "Binding and the known unbound-bridge gap" section
of `integrations/claude-plugin/README.md`.

All fixtures use a scratch HOME and XDG roots or in-memory state, loopback
stand-in servers and stand-in processes. Nothing reaches the real service,
inbox, broker, worker or Herdr, and no real harness is launched.

| Fixture                                                                  | Proves                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/clankie/test/operator-seat-bindings.test.ts` (14)                  | Registry: genuine bridge admitted; launcher admitted for pumps; a nested stray sharing the genuine ancestors and the nonce refused; missing or wrong nonce; unrelated process; no conversation or `global-default`; no provable socket; reused pid (new birth) and dead launcher drop the binding; one live claimant, re-claim after it exits; a second controller refused while the first lives; invalid registrations; the wrapper hop only at depth 2. |
| `apps/clankie/test/operator-seat-binding-routes.integration.test.ts` (8) | The same through the real seat routes over real HTTP sockets (stand-in kernel keyed on fixed client ports): `/v1/mcp`, events, ack and reply refuse an unregistered, nested or mis-claimed caller with zero effect on the captain; bearer-only routes still work; an in-process caller with no socket is refused.                                                                                                                                         |
| `apps/tui/test/mcp-unbound-bridge.integration.test.ts`                   | A bridge with no conversation exits before any request; a bound bridge asks for its own conversation and presents the nonce; the launcher registers the harness pid with only a hash of the nonce, heartbeats and withdraws.                                                                                                                                                                                                                              |

Revert proof for the service-side design: `refuseUnboundOperator` in
`apps/clankie/src/app/seat-routes.ts` was disabled in a scratch edit (restored
byte-identical afterwards) and the route fixture run. 5 of 8 failed (no
registration refused, nested stray admitted, wrong claim/conversation/second
claimant admitted, stale binding admitted, in-process caller admitted); the 3
that pass do not depend on the enforcement. The earlier client-only guard (commit
b8991274e) failed 5 of 8 unbound cases the same way when removed; it is now only
a fast diagnostic.

Not proven without a real launch: that each harness's bridge is the registered
process's direct child (Claude `claudeN` alias, Codex app-server, OpenCode plugin
host, Grok ACP agent), and the Prime Agent seat (no launcher-visible pid).

## R2 successor

The source checkpoint above received CHANGES (candidate `f433c9f3`, patch
`08187b2c…`), not approval. Its failures and claims remain historical evidence.
The [bounded r2 repair](../2026-10-26-vuh-2816-r2/README.md) adds native process/MCP
proof, registration parent verification, nonce confinement and refusal diagnostics.
Real harness/Prime and installed acceptance remain open.
