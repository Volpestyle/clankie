# Rivals shared play ownership

Verified on main under VUH-1849. The landing gate passed: 31 workspace typecheck
tasks and 7,564 tests (57 existing skips), with no exception or new exclusion.
The covering run passed all 16 tests, including 10 new HTTP boundary cases.

VUH-1849 adopts the common game-extension lifecycle without changing Rivals'
native real-time tactical policy. Its registered skill/session-server descriptor
uses the existing `gameplay` settings and broker credential. Core captures the
authenticated conversation and persists the original origin, unguessable native
request nonce and native session/start-time/execution receipt before admitting
running. It reserves the same durable `play` lease used by Pokémon/Minecraft.

The adapter requests stop for the original controller only. A matching native
`stopped` phase, no error and post-cleanup `endedAt` prove release. Missing or
replacement sessions, failed cleanup, denied stop and HTTP timeouts retain the
lease and uncertain registration. Restart recovery uses the original persisted
receipt and the existing incarnation-fenced body recovery operation. Changing
settings cannot redirect cleanup. A lost start reply is reconciled by its saved
nonce, never a repeated start.

The native server's receipt ordering was inspected in `rivals-agent`
`agent/session.py` at `757b92deba9da608c6e551d6a1eff27808385562`:
`stopped` precedes cleanup; cleanup failure sets `failed`; `endedAt` follows the
pad/capture cleanup. That repository and its policy were not changed here.

## Verification scope

The retained checks exercise real loopback HTTP, broker/file settings stores,
durable lease restart, registered operator routes and captain tools. The isolated
session-server fixture supplies controlled native lifecycle receipts and fault
responses; it has no game/controller body and does not replay footage. A real
five-second client timeout is tested. No fetch, lease, registry, credential store
or API is mocked in the new integration suite.

Coverage includes other-game exclusion, owner-scoped stop/objective, delayed
cleanup, denied stop, lost replies, replacement refusal, exact restart recovery,
origin pinning, inert discovery, dynamic route/tool removal, and captured grants
surviving admission turns while revocation retains ownership. Existing Rivals
transport and CLI checks remain covering regressions.

Checks and landed revision are recorded in [checks.txt](checks.txt). No live PC,
Rivals/game body, deployment, restart, model call or eval is part of this evidence.
The bridge remains disabled under VUH-1325.
