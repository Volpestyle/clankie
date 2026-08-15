# apps/clankie/src/captain/model.ts

Bridges the clankie credential broker
(Keychain-backed, written by the TUI /auth flow)
into pi-ai's `CredentialStore`, so pi resolves
keys and refreshes OAuth tokens against the same
store the rest of the system uses.

`BrokerCredentialStore` maps the shapes both
ways (api ↔ api_key, oauth ↔ oauth, wellknown
surfaces as an api key and is protected from
being round-tripped back over the stored pair)
and serializes `modify()` per provider — pi
runs OAuth refresh inside it, and two lanes
refreshing concurrently would strand the second
token.

`createCaptainModelRuntime(repoRoot)` builds
pi's `ModelRuntime` over that store and returns
`resolveModel()`, which reads the configured
captain model from clankie.json and fails with
a sayable `CaptainModelError` ("run /model", or
"not in pi's catalog").
