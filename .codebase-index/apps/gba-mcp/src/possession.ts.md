# apps/gba-mcp/src/possession.ts

The possession lease: one mind drives the
body at a time. An external harness is a
holder of a revocable lease, not a second
concurrent driver; the possessor is its own
principal class (`mcp_possessor`), neither
the ambient nor the voice tier.

Exports `PossessionLease`:

- `acquire(holderId, {force})` — refuses
  holders not on the allowlist
  (deny-by-default: empty list means
  possession is off) and refuses taking a
  live lease without `force`; a forced
  take is a logged "stolen" event.
- `current()` — applies TTL expiry
  (default 10 min) lazily on read.
- `release(token)` — ignored unless the
  token matches the live grant.
- `assertMayAct(token)` — the gameplay
  gate; observation never calls it. Acting
  slides the expiry, so TTL bounds idle
  holders, not session length.

Every transition fires `onEvent`
(acquired/released/expired/stolen/refused)
and `onHeldChange` suspends/resumes a
co-hosted free-play loop as the body
changes hands. `parsePossessionHolders`
parses the comma-separated env allowlist,
treating unset as off.
