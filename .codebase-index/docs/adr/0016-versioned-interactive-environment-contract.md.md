# docs/adr/0016-versioned-interactive-environment-contract.md

Provider-neutral game-environment contracts:
`@clankie/interactive-environment` owns session,
lease, command, action-result, observation, and
event schemas; adapters depend inward and never
export Mineflayer types.

Read when changing environment schemas. Key
rules: tool exposure is a deterministic projection
of session phase and lane (dormant = join+status
only); commands carry lane, authority, and
`goalVersion` (stale versions rejected); every
contract carries `schemaVersion` with dual-read /
single-write migration; raw ticks and packets
never enter semantic events. Frozen v1 lifecycle.
