# @clankie/game-extension

A typed composition contract for game extensions. Games keep their own motors,
actions and observations; core supplies durable authority and approved host
ports. See [ADR 0234](../../docs/adr/0234-games-share-one-extension-contract.md).
Its descriptor and health types come from
[`@clankie/extension`](../extension/README.md), the contract every Clankie
extension shares ([ADR 0328](../../docs/adr/0328-clankie-is-a-core-with-extensions.md)).

An extension declares `contractVersion: 1`, `id`, `connector`, `skill`,
`settings` (existing key and parser), `activity` (surface or `null`), and
`create(host)`. Its runtime implements `start(request, control, onRunning)`,
`stop(sessionId)`, `status()` and `health()`. Await status/health; a connector
may implement a read-only remote check, while the shared wrapper returns local
projections immediately.

`createGameExtensionRuntime` supplies the shared local lifecycle. It checks the
host guard before entering execution and before `onRunning`. The connector
must check the same guard at every effect and call `confirmStopped` only after
exact departure or a proven no-join refusal. A settled promise, timeout, stop
request or health result cannot release the host's play lease. Unconfirmed
cleanup retains `uncertain` and rejects another start. Core owns restart
recovery; this helper is deliberately not a durable lease store.

`ready` is local lifecycle health. It does not probe credentials, worlds,
media or models. Request and result remain extension-typed, so the host can
preserve existing validated game APIs and refusal receipts.

[Pokémon](../../integrations/pokemon/README.md) is the first implementation.
Minecraft also implements it. `GameExtensionRegistry` validates descriptors,
creates trusted factories with approved host ports, returns their typed runtime,
and projects local state through a bounded catalog. Registering metadata does
not import code, install packages or grant authority. Factories stay inert until
execution or explicit activation.

A host can associate its typed tool/route projection with a registration.
`projections()` returns only current registrations. `unregister(id)` fences new
starts, verifies idle state, quiesces optional capture/polling and removes the
entry; held or uncertain state refuses. Native entry points bind the same
registration guard so a stale reference cannot join after removal.

`reconcileStopped(id, proof)` is host-only. Use it inside the existing durable,
incarnation-fenced recovery operation after exact connector termination. A
failed proof or still-running executor cannot clear uncertainty. It does not
release the host ledger.

## External extensions

A game can live outside this repository and be installed by the owner, with no
change here, as a `kind: "game"` outside extension
([ADR 0338](../../docs/adr/0338-outside-extensions-plug-into-the-same-contract.md),
[`@clankie/extension`](../extension/README.md#outside-extensions)):
`clankie extensions add FOLDER|GIT_URL --commit SHA` records it in
`installedExtensions`, and the service loads it at start
(`apps/clankie/src/outside-extensions.ts`) with the permissions the owner
granted. A module installed the older way (`clankie games extensions add MODULE`,
`gameplay.extensions`) moves there at the next start with every game port. The
source comes from owner settings, never a tool argument or model output. The
module is trusted, in-process code, not sandboxed; one that fails to load is
listed degraded and skipped.

The module imports only types (from this package or `@clankie/extension`, where
they live) and exports:

- `gameExtensionApis`, including `GAME_EXTENSION_MODULE_API` (1);
- `gameExtension`, a `GameExtension` whose `create(host)` receives a
  `GameExtensionModuleHost`;
- `projectGameExtension(runtime)`, called with the registered runtime (so starts
  keep the registry's admission fence), returning its captain tools (JSON Schema
  parameters), exact operator paths with a `fetch` handler, optional `play`
  recovery (`owns`, `recover`) and `close`.

The host supplies the owner's non-secret `options`, a private `stateDirectory`
(`<state>/game-extensions/<id>`), the core's durable play ledger (`leases`),
`createRuntime` (the lifecycle wrapper above), `credential(name)` for broker API
keys in the extension's own namespace (`ID` or `ID-*`), and `goLive` for a
read-only `/frame.png?key=` snapshot capability through the active Discord
user-session body. The host binds tools and routes to the authenticated
conversation, refuses unauthenticated requests, and runs `play.recover` inside
its incarnation-fenced recovery before `reconcileStopped`; only that outer
operation releases the ledger claim.

[Rivals](https://github.com/Volpestyle/rivals-agent) (`clankie-extension/`) is
the first external extension ([ADR 0175](../../docs/adr/0175-rivals-agent-is-a-gameplay-skill.md)).
