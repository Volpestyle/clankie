<div align="center">

<img src="branding/clankie-logo-512.png" alt="Clankie, a little robot with a sprout on his head" width="160" />

# Clankie

**Your own assistant. Your machine, models, and tools.**

A persistent AI teammate who remembers, makes things, codes, leads other agents,
and hangs out in Discord. Run him on your Mac, shape his character, and connect
the tools you want. The iPhone and iPad app gives you a window into the same
Clankie wherever you are.

[Get started](https://docs.clankie.bot/get-started/#diy-start-on-your-mac) ·
[Customize Clankie](https://docs.clankie.bot/diy/) ·
[Watch the film](https://clankie.bot/#film) ·
[Technical reference](docs/README.md)

[![License](https://img.shields.io/badge/license-Apache--2.0%20%2B%20AGPL--3.0-blue?style=flat-square)](#license)
[![built on pi](https://img.shields.io/badge/agent-pi-7c3aed?style=flat-square)](https://pi.dev)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)

</div>

## Run your own

The [Mac quick start](https://docs.clankie.bot/get-started/#diy-start-on-your-mac)
installs a self-contained bundle on **Apple silicon, macOS 14 or newer**:

```sh
curl -fsSL https://clankie.bot/install | sh
clankie
```

`/setup` connects a model (subscription, API key, or local runtime), then
offers phone pairing, account connections, and a first agent. Only the model is
required.

- [Install and pair the app](https://docs.clankie.bot/get-started/): the full onboarding path
- [Run from source](CONTRIBUTING.md): development setup and checks
- [Run on Linux](infra/hosted/README.md): advanced self-hosting, with its own capability limits
- [Release details](docs/distribution.md): checksums, layout, pinning, and upgrades

The software is free; model providers and connected services may charge.
[Hosted Clankie](https://clankie.bot) runs the same foundation on a managed
machine.

## What he does

**Keeps you company and remembers.** Talk through ideas, make drafts and
pictures, and keep memories across conversations. His persona is yours to
shape, and his history, memory, and goals live in the service, not the window.

**Browses on his own.** He has a private browser profile with his own logins,
headless by default, with a visible window when you need to take over a
sign-in ([browser contract](docs/adr/0082-clankie-holds-the-browser.md)).

**Codes and leads a team.** He works directly or hires Claude Code, Codex, Pi,
OpenCode, or Grok Build agents into real terminals in Herdr, and messages them
through each harness's own channel. Work stays in your repo's tracker or files,
and you set how agents commit, push, release, and report
([agent control](packages/agent-hosts/README.md#seat-adapters),
[working preferences](docs/cli.md#fleet-status-fleet-set-notes-text-size-size-models-mode-fleet-clear)).

**Lives on your phone.** In the iPhone and iPad app, Messages is home, Commons
shows the team as little figures, and Terminal opens the real worker panes.
[Pair the app](https://docs.clankie.bot/get-started/#bring-your-mac-s-clankie-into-the-app)
with your Mac and keep the Mac awake to reach him away from your desk.

**Hangs out in Discord.** The official bot chats, joins voice, plays requested
music, and streams his Pokémon play (from his own PokeAgents seat) through an
Activity. Screen-share watching and Go Live need the separate personal-lab body
([Discord media](docs/discord-media.md)).

**Is built to extend.** Models, skills, and connected services are independent
choices. A headless CLI, an HTTP API, and an MCP bridge expose the same
authorized tools to scripts and other agents
([customize](https://docs.clankie.bot/diy/)).

## The system underneath

Clankie is one persistent service plus the clients and connections around it.
His built-in agent runs on [pi](https://pi.dev); worker harnesses are
connections and never replace it. The host owns conversations, memory,
credentials, tool authority, and device access.

- [Architecture](docs/architecture.md): the system diagram and request flows
- [Library index](docs/README.md): every subsystem's canonical guide
- [CLI](docs/cli.md) and [HTTP catalog](apps/clankie/openapi.yaml): command and route contracts

This repository holds the service, console, relay, and public contracts. The
Clankie app and the hosted service are private
([repository boundary](docs/adr/0183-the-harness-is-public-the-hosted-service-is-private.md)).

## Contribute

[CONTRIBUTING.md](CONTRIBUTING.md) covers the toolchain, source setup, and
checks; read [AGENTS.md](AGENTS.md) before pointing a coding agent at the
checkout. Questions go to the [docs](https://docs.clankie.bot) or
[support](https://clankie.bot/support/), and security issues to
[SECURITY.md](SECURITY.md).

## License

Apache-2.0 except `apps/vox`, the native Discord media executable, which is
AGPL-3.0-or-later under its own [LICENSE](apps/vox/LICENSE). Third-party components
retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
