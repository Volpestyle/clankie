# packages/credential-broker/src/captain-credential.ts

The captain's local bearer (`clankie_cap_` +
256-bit base64url), stored under
`clankie_captain`. `resolveCaptainCredential`
treats `CLANKIE_CAPTAIN_TOKEN` as an explicit
env override (empty = typed error), otherwise
reads and pattern-validates the store;
`ensureCaptainCredential` mints on first run and
reads the durable value back so concurrent
first-run writes converge on one token. The
Discord bridge deliberately refuses this
variable — its identity is the bridge bearer.
