# ADR 0328: Clankie is a core with extensions

Status: Proposed, 2026-11-01. James added it to step 6 of the reshape ("Add it
to captain split"). One question is open: whether the Discord persona is core or
an extension. Until he answers it is an extension, and the [last section](#if-the-persona-is-core)
says what moving it would change. Step 1, the contract in
[`@clankie/extension`](../../packages/extension/README.md), landed 2026-11-01, then the
boundary check, then the relay as the first extension (`relay-extension.ts`;
machine joins now seal with the core's `sealed-values.ts`), the browser
(`browser-extension.ts`), the computer body (`computer-extension.ts`) and
media: the drawing hand, then image and video generation and skin drafts with
their tools and routes (`media-extension.ts`, `media-routes.ts`, drawing Clankie
from the core's appearance port in `ports/appearance.ts`), and Linear,
which starts with its webhook, wake, settings, mirror and cutover routes
(`linear-extension.ts`), then World's Activity routes and tools and its
PokeAgent play tools (`activity-routes.ts`, `activity-tools.ts`,
`world/pokeagent-tools.ts`, switched as `world/extension.ts`), and voice's
composer transcription and room voice routes (`voice-extension.ts`), and the
persona's HTTP routes: rooms, persona and voice settings, appearance and the
Discord body's routes (`persona-extension.ts`, reading the body's live state the
core keeps through the route host's `discordBody`), then the persona's Discord
body tools: voice membership, social actions, the server's REST and project
mirrors, and music (`captain/discord-tools.ts`, reaching the captain as
`CaptainDeps.personaTools` only while the persona is on at start, over the
core's client shapes in `ports/discord.ts`), then the captain's room turns:
framing and running a Discord message in its room, waking a room from a watch
or worker report, and the owner's `room_turn` fork (`captain/captain-discord-turns.ts`,
reaching the captain as `CaptainDeps.roomTurns` only while the persona is on at
start, over the core's shapes in `captain/room-turns.ts`; the owner check and
operator and remote-lead wakes stay core in `captain/conversation-wakes.ts`, and
a Discord-origin owner holds nothing while the persona is off; the server owner
and owner-audience checks inside a room turn are `RoomTurns` methods too), then
the persona's channel projection onto Discord rooms
(`captain/discord-channel-projection.ts`, reaching the captain as
`CaptainDeps.channelProjection` only while the persona is on at start; without
it no room goes to Discord), his look references (`persona-images.ts`, reaching
the captain as `personaLook` and voice briefings as `personaBriefing`, over the
core's `PersonaLook` shape, only while the persona is on), and the persona's
exact Discord delivery receipts (`captain/discord-turn-receipts.ts`, owned by
`personaRoutes`, which hand the core a read of them through
`discordBody.useRoomDeliveryReceipts` in the core's `RoomDeliveryReceipts`
shape). Each
extension's state shows on `/health`, `GET /v1/extensions`, `clankie extensions`,
`clankie status` and `clankie doctor --json`, and `clankie extensions on|off ID`
sets the owner's switch for the next start; the app shows and flips the same switches in Settings → Extensions.
The core-only end-to-end test (`apps/clankie/test/core-only-composition.integration.test.ts`)
starts the real service with every switch off and hires, messages, reads and
hears from an agent in a scratch Herdr; with `voice` off, joining voice and
watching screen shares now leave his tools too, with `media` off so do
`generate_image`, `generate_video`, `skin_draft` and a worker's video tool, with
`/v1/media/*` and the skin draft routes no longer mounted, and with `minecraft` off
(`minecraft-extension.ts`, a switch beside Minecraft's `GameExtension`) its game,
routes, tools, host and MCP motor are never built. Still reached with every switch
off: the persona's music and room tools, and `linear_wake` (built inside the
captain's tracker wakes).
Extends
[ADR 0234](0234-games-share-one-extension-contract.md) and
[ADR 0181](0181-clankie-is-independent-of-his-connections.md); runs alongside
[ADR 0325](0325-the-captain-splits-by-domain-without-changing-behaviour.md).

## Context

`apps/clankie/src` was about 184,000 lines on 2026-11-01. The captain directory
alone was about 92,000. One process, started by the 2,888-line
`apps/clankie/src/index.ts`, imports and wires everything in one place: Herdr and
the fleet, the built-in tracker, Discord rooms, voice and music, the Activity,
Minecraft and the PokeAgents world, computer use, the browser host, media
generation, Linear, the public gateway connector, and the TUI's own updaters.

Some of the line already exists, unnamed:

- `ClankieAppDependencies` (`app/types.ts`) takes about fifty optional ports for
  Discord, voice, the Activity, Minecraft, Linear, media, the browser and the
  persona. Leaving one out is how a test runs without that part today.
- Games share `GameExtension` and `GameExtensionRegistry` from
  `@clankie/game-extension` (ADR 0234): a descriptor, an inert factory,
  `start`/`stop`/`status`/`health`, typed host ports, and a projection that adds
  and removes tools and HTTP routes.
- The captain itself still imports Discord turns, voice lanes, personas and
  persona images directly (`captain.ts`, `captain-discord-turns.ts`).

Nothing states which parts the fleet needs and which it can live without, so
nothing checks it. The business shape needs that line: the free install is the
owner's Mac, Herdr and a Discord bot they bring; the paid part is the
clankie.bot relay (ADR 0300, ADR 0311).

## Decision

Clankie is a **core** that runs on its own, plus **extensions** that plug into it
through one contract. Any extension can be left out, or can fail, without
taking the fleet down.

### Core

The core is what a lead needs to run agents on the owner's machines:

- Machines, seats and agents: Herdr runners and the desktop app's terminals,
  hires, seat delivery, fleet observation and the roster, machine joins and
  their access ceilings (ADR 0244).
- Reports, notes and issues: worker reports, the notes board, the built-in
  tracker and plain project files (`@clankie/work-items` local and files
  backends).
- The MCP and CLI that leads and agents use, and the HTTP API under them.
- Settings, the credential broker, operator authentication, owner permission
  and the Watch level (ADR 0308).
- The captain's model loop, its identity and trust boundaries
  (`captain/instructions.md`), episode memory, and model providers.
- Leases, durable receipts and recovery, which extensions use but never own
  (ADR 0234 already keeps them in core for games).

### Extensions

Each of these becomes an extension:

| Extension          | What it holds today                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `persona`          | The Discord character: rooms, participant sessions, forum mirror, persona images, appearance, music |
| `voice`            | Discord voice, Vox, voice calls and the realtime briefing                                           |
| `world`            | PokeAgents play, the Activity watch surface, World and desktop-pet surfaces' routes                 |
| `minecraft`, games | Already `GameExtension`s; they keep that contract as a specialization of this one                   |
| `watch`            | Nothing in this service yet: the Watch app is in `clankie-app` and reads the feed the phone reads   |
| `tracker-linear`   | Linear import, mirror, cutover, webhooks and publishing                                             |
| `tracker-github`   | The GitHub issues backend                                                                           |
| `relay`            | The clankie.bot gateway connector and phone doorway                                                 |
| `computer`         | Computer use on the Mac and the PCs                                                                 |
| `browser`          | The browser host and recording                                                                      |
| `media`            | Image, video and skin draft generation                                                              |

Which hired harnesses can do computer work (`computer-use-harnesses.ts`) is
part of hiring and stays in core; the `computer` extension is Clankie's own
computer body. The core reaches media, diagrams and skin drafts through its own
ports (`ports/media.ts`), and an extension's HTTP routes mount through
`ports/routes.ts`, which gives them the core's authority checks and keeps each
route group's place in the app's middleware order.

The first seven are the ones James named. `computer`, `browser` and `media` are
proposed here because the fleet runs without them; they can move back to core
in this ADR without changing the contract.

### The contract

A new package, `@clankie/extension`, lifts the parts of `GameExtension` that are
not about games:

```ts
interface ClankieExtension<Settings, Host> {
  readonly contractVersion: 1;
  readonly id: string; // "persona", "relay", ...
  readonly settings: { readonly key: string; readonly schema: { parse(input: unknown): Settings } };
  readonly needs: readonly CorePortName[]; // which host ports it asks for, by name
  create(host: Host, settings: Settings): ExtensionRuntime; // inert: no network, no model, no joins
}

interface ExtensionRuntime {
  start(signal: AbortSignal): Promise<void>; // runs after the core is ready
  stop(): Promise<void>;
  status(): ExtensionStatus; // "off" | "starting" | "running" | "degraded" | "stopped"
  health(): Promise<{ state: "ready" } | { state: "degraded"; reason: string }>;
  projection(): ExtensionProjection; // tools, HTTP routes, CLI commands, skills, doctor checks
}
```

`GameExtension` becomes a `ClankieExtension` with its game fields (connector,
skill, Activity surface, `play` lease use) on top. Minecraft and Pokémon move
onto it with no behaviour change.

The host gives an extension only the core ports it named, as narrow typed
interfaces: post to the captain, read a lease, read settings, write evidence,
register a route. An extension never imports core modules. The core never
imports an extension; only the composition root does.

### Failure stays inside the extension

- The core boots and serves `/health`, the MCP, the CLI and the fleet with no
  extension at all. An end-to-end test starts that core-only composition and
  hires, messages and reads an agent through it (ADR 0221).
- Extensions start after the core reports ready, each inside its own error
  boundary. A throw, a rejection or a failed health check marks that extension
  `degraded` with its reason, removes its tools and routes, and logs once. The
  fleet keeps running, and `/health` keeps its core verdict separate from the
  extensions' list.
- `clankie doctor` and `clankie status` list each extension with its state and
  reason.

### One extension using another

Media draws Clankie from the persona's appearance images, and the captain's
Minecraft play reads them too. Decided 2026-11-01: the core offers an
**appearance port** (`ports/appearance.ts`), and the persona extension fills it
through its projection. While the persona is off the port reads empty, so a
picture of himself refuses with "no appearance references" and every other
picture is unchanged. Extensions keep depending only on the core, the
supervisor needs no order between extensions, and the port reads the persona's
projection when a picture is made, so media can start long before the persona
does. Ports one extension offers another were the other answer; they would
need the supervisor to order and wire extensions to each other, and nothing
else asks for that yet.

Media now owns image and video generation and skin drafts: with `media` off
none of their tools reach the captain or a worker and their routes are not
mounted (`404`). The persona keeps reading its own images for its briefings.
Minecraft play still builds its own image source (`minecraft-play-mind.ts`);
it takes the appearance port when Minecraft gets its switch.

### Open: tracker wakes live inside the conversation store

Linear is not yet one piece that can move. Its webhook routes need the
captain's wake methods; the conversation store queues, defers and records
Linear wakes in its own turn loop and keeps `linear*` cursors in each
conversation's saved metadata; the MCP hosts publish to Linear and share its
request budget; and work items import Linear projects. Moving the routes alone
would only hand the extension objects the core still builds. The planned order,
each step one pull request with no change in what he does:

1. A tracker-neutral activity type and one captain port to receive it
   (`receiveTrackerActivity`), with Linear's webhook adapting into it. Landed
   2026-11-01: `captain/tracker-activity.ts`, adapted by `linearTrackerActivity`.
2. The store's wake queue, receipts and cursors become tracker-neutral. Saved
   metadata keeps loading under the old `linear*` names until every body has
   rewritten it. Landed 2026-11-01 as code: `captain/conversations/tracker-wakes.ts`,
   the `trackerWake*` store and captain methods, and the core's
   `TrackerWakeReference`. The saved fields keep their `linear*` names for now;
   renaming them needs every body to read both names first, and buys nothing he
   would see.
3. A `tracker-linear` extension owns the webhook and settings routes, its
   client, request budget and mirrors, and projects its work-items backend.
   The routes, mirror and cutover commands included, landed 2026-11-01: they mount
   as `tracker` routes where they always did, and the core's route host gives
   them its operator and owner checks, settings, clock and tracker wakes.
4. The MCP hosts publish through the work-items port, so neither imports a
   tracker. Landed 2026-11-01 as ports the composition root fills: the MCP
   host's `TrackerMcpAdapter` (`ports/tracker-mcp.ts`, filled by `linearMcp`)
   carries the GraphQL escape hatch, worker publishing, compact write results
   and budget refusals; catalog entries mark tools that write as a persona
   (`writesAsPersona`), so worker grants name no tracker; work items take the
   tracker's projects as `trackerProjects`; and fetched evidence bytes go
   through the core's evidence store. The core imports no `tracker-linear`
   file.

GitHub and files trackers already sit behind `@clankie/work-items`; they move
the same way once step 4 lands.

### Choosing extensions

Settings gain one `extensions` map from id to on or off, with defaults that
match the free install: `persona`, `voice`, `world`, games, `computer`,
`browser` and `media` on; `relay` on only once the owner signs in to
clankie.bot; `watch` on once a Watch is paired; each tracker on once it is
connected. The CLI is the interface (`clankie extensions`, `clankie extensions
on <id>`, `clankie extensions off <id>`); the app shows them in Common settings
through the same API.

### If the persona is core

Today `persona` sits in the extension table. If James puts it in core:

- `persona` leaves the table and is wired by the core composition instead of
  the extensions map; its code and its host ports stay the same.
- It can no longer be switched off, and a failure in it counts against the core
  verdict.

The contract, the other extensions and the build order below do not change.
Either way, the captain's identity and trust boundaries stay in core; the
persona extension is the owner-authored character, its rooms and its voice.

## Order

Each step is one green pull request with no behaviour change unless it says so.

1. Add `@clankie/extension`, and make `GameExtension` and its registry a
   specialization of it. Minecraft keeps passing its tests unchanged.
2. Add `scripts/check-extension-boundary.mjs` to the landing gate. It sorts
   `apps/clankie/src` into the core and the extensions above by path, and fails
   when the core gains an import of an extension. The composition root
   (`index.ts`, and `dormant-body.ts` for a dormant body) is the one place
   allowed to. On 2026-11-01 the rest of the core had 123 such imports from 39
   files, listed in a baseline that only shrinks.
   Then add the core-only composition and its end-to-end test; each import left
   gets a host port.
3. Move the small extensions first: `relay`, `watch`, `tracker-github`,
   `tracker-linear`, `media`, `browser`, `computer`.
4. Move `world` and `voice`.
5. Move `persona` last. It depends on ADR 0325's remaining step:
   `submitDiscordTurn` and the room conversation methods leave `createCaptain`
   into the persona extension rather than into a `captain-*.ts` file.
6. Add the `extensions` settings, CLI and doctor rows, then the app's Common
   controls.

Steps that need the real Discord bot, Herdr, Vox or the Mac's computer use are
built and proven by Clankie's own workers on the owner's machines; the contract,
the composition and the moves that cloud checks can prove run in the cloud.

## Consequences

- A free install can leave out what it doesn't use, and a broken Discord token,
  Linear outage or game server no longer threatens the fleet.
- The line between core and extension is checked on every landing, not kept
  by convention.
- Each extension's settings, tools and routes live in one place, which makes
  the captain smaller in the same stroke as ADR 0325.
- There is one more layer between the captain and Discord, and moving the
  persona is the largest single step of the reshape so far.
- The fifty optional ports in `ClankieAppDependencies` shrink as extensions
  move; the ones left are the core's.
