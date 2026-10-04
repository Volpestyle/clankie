# Public contracts

`@clankie/protocol` owns the schemas and wire types shared by Clankie's service,
clients, relay, and hosted-service boundary. It depends on Zod, with no other
workspace package dependencies. It does not run agents, store credentials, or
implement a gateway.

The package's [exports](package.json) are the public entry points. The root
[index](src/index.ts) defines the operator-conversation and related contracts;
separate entry points cover device encryption, public gateway routes, connected
accounts, work items, model keys, and hosted pairing/operation. Read the owning
schema rather than copying a payload shape into documentation.

## Consumers and compatibility

The private companion-app and managed-service repositories consume this package
from a sibling checkout. A contract change here can affect both. Keep wire
identifiers stable, validate at trust boundaries, and coordinate incompatible
changes with every consumer. A legacy field such as `missionId` or a
`captain.*` identifier is a compatibility name, not current product terminology.

Client JSON response boundaries use `parseProtocolResponse(schema, value)` or
`safeParseProtocolResponse` from the root export. These readers discard unknown
object keys at every reported level, then validate the known shape using the
original schema. Optional host additions therefore remain readable by an older
client of the same wire version. Known values, bounds, versions and discriminators
still fail validation when invalid. Dynamic record keys and declared catchall
data remain intact. Use ordinary strict schema parsing for requests, persisted
state and authenticated encryption envelopes; response tolerance grants no
authority and never changes those schemas.

VUH-1635 exposed this distinction when new subagent metadata made an older
app reject an entire successful fleet response. Existing installed clients
with strict response parsing need new bundled JavaScript to gain tolerance.
Omitting new optional fields at the host's device boundary can mitigate them,
but withholds that metadata until those clients update or negotiate a view.

[Architecture](../../docs/architecture.md) explains the service boundaries.
[OpenAPI](../../apps/clankie/openapi.yaml) catalogs HTTP operations.
The [public network reference](https://docs.clankie.bot/network/) renders the
host-route allowlist from [public-gateway.ts](src/public-gateway.ts); the hosted
account service has separate routes and implementation.

```sh
pnpm --filter @clankie/protocol typecheck
pnpm --filter @clankie/protocol test
```

This package is Apache-2.0. The [public/private boundary](../../docs/adr/0183-the-harness-is-public-the-hosted-service-is-private.md)
keeps client and managed-service implementation in their respective repositories.
