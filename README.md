<div align="center">

<img src="branding/clankie-logo-512.png" alt="Clankie" width="200" />

# Clankie

**Your persistent lead. Your choice of worker harnesses.**

Clankie keeps conversations and ongoing goals in a persistent service on your
machine, reached through the terminal console, app and Discord. Swarm MCP carries
agent coordination; the built-in worker route uses Herdr. His
[connection architecture](docs/adr/0181-clankie-is-independent-of-his-connections.md)
keeps portals, execution runtimes and optional work trackers independent.
[Current support](packages/swarm/README.md#connection-contract-status) distinguishes
the implemented integrations from the remaining work.

The companion app brings that same work into three views: **Messages** to
talk to Clankie and the team, **Terminal** to reach their Herdr panes, and
**Commons** to see swarm activity and open the agent behind it.

[![License](https://img.shields.io/badge/license-Apache--2.0%20%2B%20AGPL--3.0-blue?style=flat-square)](#license)
[![built on pi](https://img.shields.io/badge/agent-pi-7c3aed?style=flat-square)](https://pi.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

</div>

---

## What he does

- **Leads ongoing work.** Clankie runs on pi in the local service, reached
  through the TUI or app. He can code himself, delegate to workers in Herdr,
  watch their completion, and continue an owner-approved goal. His model and
  each worker's harness are separate choices.
- **Makes the fleet visible.** Messages holds durable agent contacts and
  shared conversations. Terminal opens live worker panes, with input when
  granted. Commons places agents by working directory and shows activity,
  delegation, and message exchanges; tap a figure to chat or reach its controls.
- **Discord teammate.** A real member of your server: bounded text turns,
  consented group voice, pictures ride his replies, and he remembers the
  people he talks to. Ask him to search or play YouTube music in voice; he can
  also stay silent — silence is a real answer. Each media-enabled active Discord
  body owns one native Vox child for voice capture, TTS, and audible music; a
  text-only official-bot process does not spawn Vox.
- **Plays games on stream.** Pokemon FireRed/Emerald from his own credentialed
  seat in a hosted PokeAgents world, watchable live in a Discord Activity with
  voice commentary over the run. Other agents join the same world through
  PokeAgents' own MCP, CLI, or skill — parent conversation plus a driver (MCP
  Task, subagent, or CLI loop) — and get their own seats; nobody takes
  Clankie's body or receives his room input.
- **Makes things.** Image and video generation behind one provider-neutral
  seam (OpenAI, Google, Grok); a browser via the agent-browser MCP host.
- **One Clankie everywhere.** The TUI, Discord, voice, and gameplay are rooms,
  not separate agents: he can read his other rooms, and his persona is
  owner-authored settings, never caller input.

## Get started

On a Mac running macOS 14 or newer on Apple silicon:

```bash
curl -fsSL https://raw.githubusercontent.com/Volpestyle/clankie/main/install.sh | sh
clankie
```

The launcher starts the service and opens the console, the primary place to
work with Clankie as your lead. In it, `/auth` stores a
provider key or OAuth login in the Keychain-backed credential broker and
`/model` picks the captain model. That is the whole setup; talk to him.
`/persona`, `/image-model`, `/discord`, and `/connect` are optional.
`clankie doctor` prints the install card whenever you want to know what is
configured.

Ask him to use the worker harnesses you prefer; those harnesses need to be
installed and authenticated on the host. For ongoing work, `/goal <objective>`
sets a durable goal and `/autonomy on` enables continuation. The service keeps
running when you close the console; your Mac must remain awake and online.

### Reach him from your phone

The iPhone and iPad app is a companion that reaches your Mac through
`api.clankie.bot`. Clankie and the workers run on your Mac; model requests use
the providers or local runtimes you configure. Four more steps:

1. **Sign the Mac in.** `/gateway`, choose **Enable remote access**, enter the
   email your invitation named, then the one-time code it receives. That
   enrolls this Mac at the public doorway under your account. There are no
   URLs, host ids, or tokens to copy.

2. **Keep him running.**

   ```bash
   clankie autostart enable
   ```

   Clankie and his relay now start when you log in. Leave the Mac awake and on
   power if you want him reachable while you are away.

3. **Install the app** from your TestFlight invitation and open it.

4. **Pair the phone.**

   ```bash
   clankie pair
   ```

   Scan the QR, or type the code, in the app; review the access it offers and
   connect. Each offer is single-use. `clankie devices` lists and revokes paired
   devices.

From here, use Messages to direct the work, Terminal to inspect or control a
worker pane, and Commons to follow activity across the fleet. The app and TUI
reach the same Clankie service on your Mac.

Gateway sign-in is invite-only during the beta: step 1 needs the email an
invitation was sent to.

### Reference

Every headless noun's flags, JSON, and exit codes are in
[`docs/cli.md`](docs/cli.md); `clankie help` prints the index. Where each
secret lives and who verifies it is in
[`docs/credentials.md`](docs/credentials.md). The installed layout and version
pinning are in [`docs/distribution.md`](docs/distribution.md).

### From a checkout

Install Node 24+, pnpm 11+, Git, Rust 1.88+, and CMake, then:

```bash
corepack enable
pnpm install
pnpm doctor          # toolchain and credential status
pnpm cli:install     # symlink the `clankie` launcher into ~/.local/bin
clankie
```

The steps above are the same from a checkout.

## Apps

| App                                                                | What it is                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| [`apps/clankie`](apps/clankie)                                     | The service: captain, tools, bodies, API (:4310). [HTTP catalog](apps/clankie/openapi.yaml) |
| [`apps/tui`](apps/tui/README.md)                                   | Operator console and the `clankie` launcher                                                 |
| [`apps/menu-bar`](apps/menu-bar/README.md)                         | Native macOS menu bar: private local voice and operator conversation tails                  |
| [`apps/discord-bridge`](apps/discord-bridge/README.md)             | Official bot: text, voice, attachments                                                      |
| [`apps/discord-user-session`](apps/discord-user-session/README.md) | Personal-lab voice, screen-watch, and Go Live body (off by default)                         |
| [`apps/discord-activity`](apps/discord-activity/README.md)         | The watch-me-play surface                                                                   |
| [`apps/relay`](apps/relay/README.md)                               | Remote access for the phone/desktop app                                                     |
| [`apps/vox`](apps/vox/README.md)                                   | Sole native Discord media owner behind an AGPL process boundary                             |

The companion app and the hosted gateway behind `api.clankie.bot` live in
private repositories; this one holds everything that runs on your machine
([ADR 0183](docs/adr/0183-the-harness-is-public-the-hosted-service-is-private.md)).

[`packages/play`](packages/play/README.md) is the play mind above the body
seam; `packages/` holds the shared contracts. The body itself is his seat in a
PokeAgents world ([ADR 0145](docs/adr/0145-the-world-is-the-only-body.md), and
[ADR 0129](docs/adr/0129-each-player-owns-a-body.md) for the identity boundary).
The iPhone, iPad, and macOS companion app is a separate private repo
(`clankie-app`).

## Development

```bash
pnpm typecheck
pnpm deadcode
pnpm test
pnpm check           # required final check: fmt, lint, docs links, typecheck, tests
pnpm play:live       # watch a playthrough without the service or a Discord ask
pnpm discord:readiness
```

If you drive agent panes with [herdr](https://herdr.dev), link Clankie's
plugin once to get his fleet board, operator console, and status popup as
first-class herdr panes — `pnpm doctor` (checkout) or `clankie doctor`
(any install) reports whether it is linked:

```bash
herdr plugin link "$PWD/integrations/herdr-plugin"
```

An installed release ships the same plugin; `clankie doctor` reports
`herdrPlugin.bundlePath`.

Requirements, keybindings, and troubleshooting live in
[`integrations/herdr-plugin/README.md`](integrations/herdr-plugin/README.md).

See [`docs/architecture.md`](docs/architecture.md) for the system shape,
[`docs/cli.md`](docs/cli.md) for the headless `clankie` command contract,
[`docs/distribution.md`](docs/distribution.md) for binary installation,
[`docs/credentials.md`](docs/credentials.md) for bot/user/internal token
boundaries, and [`docs/discord-media.md`](docs/discord-media.md) for YouTube
music, the Activity, Go Live, and share watching. Read [`AGENTS.md`](AGENTS.md)
before pointing a coding agent at this repo.

## License

Apache-2.0 except `apps/vox`, which is AGPL-3.0-or-later under its own
[`LICENSE`](apps/vox/LICENSE). Third-party dependencies retain their own
licenses; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
