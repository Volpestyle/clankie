# ADR 0234: Games share one extension contract

Status: proposed implementation, 2026-10-06; lifecycle registration and Minecraft
adoption implemented under [VUH-1616](https://linear.app/vuhlp/issue/VUH-1616),
2026-10-08. Rivals exact-stop and lease adoption is implemented under
[VUH-1849](https://linear.app/vuhlp/issue/VUH-1849). Owner-installed external
modules added 2026-10-17 ([VUH-2419](https://linear.app/vuhlp/issue/VUH-2419)); see
the amendment below. Extends
[ADR 0145](0145-the-world-is-the-only-body.md),
[ADR 0175](0175-rivals-agent-is-a-gameplay-skill.md), and
[ADR 0219](0219-minecraft-is-an-mcp-connected-body.md).

## Context

Pokémon's native PokeAgents client and Minecraft's service-owned MCP connection
both have a guarded session, a mind above their motor, settings, a gameplay
skill, and a watch surface. Both share the `play` lease and require exact
termination evidence. Their inputs, observations, session generations, and
motor timing differ. Rivals already has a skill and its own session server.

## Decision

Use the in-process `GameExtension<Request, Result, Settings, Host>` contract in
`@clankie/game-extension`. Each trusted extension declares a version, identity,
connector (native package, MCP connection, or skill/session server), skill path,
existing settings key and parser, and an optional Activity surface. Its factory
receives typed host ports and returns `start`, `stop`, `status`, and `health`.
Request and result types remain game-specific. A Minecraft action is not a GBA
button press, and neither motor moves into this contract.

Core retains durable play leases and recovery, owner/admin authority,
destination policy, persona/model selection, Discord/Activity connections,
and audit/evidence projections. Extensions provide their connector, driver,
rendered media and journal production. Game-specific journals remain evidence,
never authority. An extension cannot acquire a lease or choose a publishing
room by declaring metadata. Its host ports supply only the approved destination.

```mermaid
flowchart LR
  Entry["Existing API / CLI / TUI / tools"] --> Core["Core: lease, authority, recovery, destinations"]
  Core -->|"guard + exact-stop receipt + host ports"| Extension["GameExtension lifecycle"]
  Extension --> Game["Game-owned connector and motor"]
  Extension -->|"media, observations, journal"| Evidence["Core Activity / voice / evidence consumers"]
```

`start` runs until execution and cleanup settle. The host authenticates the
request before calling it; its guard is checked before connector entry, at
running admission, and at each game effect. `stop(sessionId)` requests a stop
for exactly that local run and returns no termination proof. `onRunning` occurs
once after joining and before the first turn.

The shared lifecycle wrapper keeps `starting`, `running`, and `stopping` local
state. Without a connector's confirmed-stop callback it retains `uncertain`
and refuses reuse, even when execution returned or threw. The wrapper's status and health are
read-only local projections: `ready` means no local termination uncertainty,
not proof of credentials, a reachable server, or live video. Durable recovery
stays with the core's existing session record and exact connector receipts;
this wrapper does not invent a second lease or persistent recovery store.
The contract also permits asynchronous read-only status/health for MCP and
session-server connectors; neither operation may join a world or call a model.

## Registration and discovery

A trusted service composition registers an installed factory with
`GameExtensionRegistry.register(extension, host, projection)`. The descriptor is
validated and copied before constructing the runtime. Duplicate IDs are refused
before factory invocation. A factory is inert: creating or discovering it may
read its persisted local state, but cannot join a game, start capture or call a
model. Minecraft explicitly activates its idle polling/capture after host boot.
The registry is an in-process installation boundary for reviewed, bundled code;
metadata never imports a path, installs an npm package or grants permissions.

The optional projection owns a game's domain tools and exact HTTP route paths.
Core supplies the authenticated turn and operator authorizer, settings source,
and approved private connector port. Tool catalogs and HTTP dispatch consult the
current registrations. Unregistering an idle extension quiesces capture/polling
and removes its tools, routes and discovery entry without changing core. Held,
starting, stopping and uncertain lifecycles refuse removal. Registration fences
also protect older native API references after removal; pending Minecraft join
admission is visible before its first awaited authority/profile read.

`GET /v1/games/extensions`, `clankie games extensions` and TUI `/games extensions`
share a bounded owner-authenticated catalog. It exposes descriptor metadata,
local lifecycle status and health, never credentials, endpoints, action/chat
history or model output. `ready` remains local lifecycle health, not live-body,
credential, reachability or media proof. Provider errors become a fixed degraded
result; discovery never initiates gameplay.

Core retains the durable ledger and exact native restart recovery. After that
incarnation-fenced operation proves the connector ended, it reconciles a settled
uncertain runtime with `reconcileStopped`. A deadline, replacement session,
requested stop or failed proof cannot clear it. Reconciliation does not create
another ledger or release a claim itself.

## Adoption

| Game      | Extension-owned implementation                                                                                                                                                                                                                                                                     | Host boundary / remaining work                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pokémon   | `integrations/pokemon`: existing typed native factory, connector, executor and journal production; registered runtime persists across sittings                                                                                                                                                     | Core keeps authenticated entry, play lease, world-session receipt and exact restart recovery. Existing settings key is `gameplay`, skill is `pokeagents`, Activity surface is `gba_emulator`.                                                                                                                                                                                                                                                                                  |
| Minecraft | `integrations/minecraft`: native port schemas, MCP adapter, persisted connector state machine, driver handoffs, play host, capture, domain tools and routes; factory owns activation and quiescence                                                                                                | Core supplies the durable play ledger, current conversation authority, owner/admin checks, fresh DNS/profile policy, broker-private MCP capability, persona/model selection and approved sinks. Existing key/skill/surface remain `minecraft`.                                                                                                                                                                                                                                 |
| Rivals    | External since 2026-10-17: `clankie-extension/` in the Rivals Agent repository implements the module contract below (ADR 0175 amendment). It keeps the skill/session-server connector, high-level objective requests, native sitting IDs, bounded status/frame replies and read-only watch surface | Loaded from `gameplay.extensions`. Core supplies authenticated conversation authority, the durable play ledger, the lifecycle wrapper, its own broker credentials and the Go Live port; the extension persists the original origin/request/session receipt and holds the play lease until matching native `stopped` plus post-cleanup `endedAt`. Host recovery runs its `play.recover`, then `reconcileStopped`. The native fast policy remains outside the turn-based kernel. |

Minecraft's compatibility files re-export the integration implementation. Its
persisted session/connection generation, guard at final dispatch, worker-driver
handoff and exact disconnect rules remain the existing ones. Ending a mind
burst or handing control to an owner does not end the connector stay. Original
operator API, CLI and TUI settings/commands remain compatible. Host account
setup, administrator identity, invitations, publishing destinations and their
audit remain core authority projections, not extension-authored grants.

## Verification

[Registration evidence](../testing/2026-10-08-game-extension-registration/README.md)
records the isolated native IPC, real Mineflayer packet/MCP/worker boundary,
owner-authenticated HTTP/CLI and settings projection checks. Earlier
[Pokémon adoption evidence](../testing/2026-10-06-game-extension/README.md)
remains valid for unchanged execution behavior. These fixtures do not prove a
live game body, paid model, Discord stream or deployment.

## Amendment: owner-installed external extensions (2026-10-17, VUH-2419)

James moved Rivals out of core (ADR 0175 amendment), so a game must be able to
live in another repository and be enabled without a core change. The registry
above stays an in-process boundary for trusted code, and descriptor metadata
still imports nothing. What changes is who chooses the code: besides the bundled
Pokémon and Minecraft compositions, the owner may install modules by absolute
path in `gameplay.extensions` (`clankie games extensions add MODULE [KEY=VALUE...]`,
`/games extensions add`, or the existing owner-authorized games configuration
API). The service imports them at start, like its runtime provider module; a
tool argument or model output never names a module. A module that fails to load
is logged and skipped without affecting other games.

```mermaid
flowchart LR
  Owner["Owner: games extensions add"] --> Settings["gameplay.extensions"]
  Settings -->|"service start"| Loader["Module loader"]
  Loader -->|"host ports"| Module["External module: gameExtension + projectGameExtension"]
  Loader --> Registry["GameExtensionRegistry"]
  Module -->|"tools, paths + fetch, play.recover"| Registry
  Registry --> Entry["Captain tools / operator API / discovery / recovery"]
```

The public contract is `@clankie/game-extension`'s `src/module.ts`. A module
imports only its types and exports `gameExtensionApis` (including API 1),
`gameExtension` and `projectGameExtension(runtime)`. The host ports are the
owner's non-secret options, a private state directory, the durable play ledger,
the shared lifecycle wrapper, API keys in the extension's own broker namespace
(`ID` or `ID-*`) and a Go Live request for a read-only snapshot capability. The
projection returns JSON Schema tools, exact paths with a `fetch` handler, and
optional `play` recovery and `close`. The host binds tools and routes to the
authenticated conversation, refuses unauthenticated requests, and runs
`play.recover` inside its incarnation-fenced recovery before `reconcileStopped`;
only that operation releases the ledger claim. Bundled games are unchanged.

[Integration evidence](../../apps/clankie/test/outside-extensions.integration.test.ts)
installs a fixture module through the CLI writer, loads it beside a missing one,
and checks owner-authenticated discovery, routes and tools, scoped credentials,
and play recovery across a real ledger restart.

Since 2026-11-01 these modules are one form of outside extension
([ADR 0338](0338-outside-extensions-plug-into-the-same-contract.md)): the types
moved to `@clankie/extension` (`src/game.ts`), `outside-extensions.ts` loads them
with the owner's per-permission grants and switch, and `gameplay.extensions`
entries move to `installedExtensions` at the next start.
