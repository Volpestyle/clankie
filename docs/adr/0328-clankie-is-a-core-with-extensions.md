# ADR 0328: Clankie is a core with extensions

Status: Proposed, 2026-11-01. James added it to step 6 of the reshape ("Add it
to captain split"). One question is open: whether the Discord persona is core or
an extension. Until he answers it is an extension, and the [last section](#if-the-persona-is-core)
says what moving it would change. Step 1, the contract in
[`@clankie/extension`](../../packages/extension/README.md), landed 2026-11-01, then the
boundary check, then the relay as the first extension (`relay-extension.ts`;
machine joins now seal with the core's `sealed-values.ts`) and the browser
(`browser-extension.ts`).
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
computer body. The core reaches media and diagrams through its own ports
(`ports/media.ts`).

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
