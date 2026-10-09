# Public contracts

`@clankie/protocol` owns the schemas and wire types shared by Clankie's service,
clients, relay, and hosted-service boundary. It depends on Zod, with no other
workspace package dependencies. It does not run agents, store credentials, or
implement a gateway.

`@clankie/protocol/composer-transcription` defines bounded recording chunks,
availability and draft receipts. Its WAV parser validates actual sample bytes
without Node dependencies. The [composer API guide](../../docs/composer-transcription.md)
describes paired-device authority, cancellation and the unchanged encrypted
transport limit. Provider credentials and plan configuration remain private.

The package's [exports](package.json) are the public entry points. The root
[index](src/index.ts) defines the operator-conversation and related contracts;
separate entry points cover device encryption, public gateway routes, connected
accounts, work items, model keys, and hosted pairing/operation. Read the owning
schema rather than copying a payload shape into documentation.

`@clankie/protocol/tool-output` shares tool-result decoding between the TUI and
companion app. It unwraps MCP content/envelopes, native Codex text parts, and
repeated JSON encoding while retaining image order and unknown content. It has
no Node dependencies. Host-specific exec and receipt presentation stays in the
TUI; this helper preserves their decoded JSON for app detail views.

## Consumers and compatibility

### Seat input capabilities (VUH-1882 service contract)

Every current roster/fleet seat publishes optional `inputCapabilities`:

```json
{
  "deliveryModes": ["steer", "queue"],
  "interrupt": true,
  "nextTurnOnly": false
}
```

The source is `FleetSeatInputCapabilitiesSchema`. `deliveryModes` lists only
explicit choices the current native connection can honor; array order has no
meaning. `interrupt` means the existing authenticated `stop_task` operator
operation can stop that exact task. A harness's generic interrupt method or
terminal Escape key does not establish this capability. `nextTurnOnly` means
Claude has only an authenticated next-UserPromptSubmit receiver: Queue can be
stored, but Steer cannot wake or modify its current turn. A live exact-session
Claude poll offers both modes; unverified Claude offers neither. Codex's native
queue is separate from its steer control; OpenCode declares Queue, Pi and Grok
declare neither. Mailbox-only seats do not gain native choices from storage.

App composers should match the current seat by `occupantId` and offer only the
listed modes. No modes means plain Send. Missing `inputCapabilities` on an older
service means unknown: offer plain Send, with no inferred Steer/Queue/Stop.
Show Stop only when `interrupt` is true and a task is running; keep ordinary
authorization and operation-result handling. Capabilities are observations,
never authority or a delivery guarantee. They can disappear after a receiver
expires, a native control releases or the occupant changes. Re-read the roster;
the service still refuses unsupported explicit modes from older clients.
Explicit Steer to next-turn-only Claude is rejected without sending or storage,
including when the same text already has a next-turn receipt. Plain Send keeps
its existing automatic routing.

This additive service contract supports the separate VUH-1882 composer work and
VUH-1883 Send-to-Stop UI. No app UI is changed in this repository.

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

So a response grows only by new optional keys, including new optional objects
such as a seat's `owner` (VUH-1763). A new value in an existing enum or
discriminated union is a known-field change that an older reader rejects;
give it a new optional key, or a new `schemaVersion`, instead.

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

Managed credit schemas and route declarations live in private
`clankie-ops/packages/hosted-protocol`, outside this package. The public service
accepts exact optional route declarations from its installed runtime provider;
ordinary installations add none. The private companion app keeps its consumed
credits decoder locally and does not require the operations repo in CI.

```sh
pnpm --filter @clankie/protocol typecheck
pnpm --filter @clankie/protocol test
```

This package is Apache-2.0. The [public/private boundary](../../docs/adr/0183-the-harness-is-public-the-hosted-service-is-private.md)
keeps client and managed-service implementation in their respective repositories.
