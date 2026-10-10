<div align="center">

<img src="branding/clankie-logo-512.png" alt="Clankie, a little robot with a sprout on his head" width="160" />

# Clankie

**An agent lead with a personality. Your machine, models, and tools.**

Clankie plans your work, hires coding agents to do it, owns it until it lands,
and makes as many of the calls as you let him. Between jobs he has ideas of his
own and hangs out in your Discord. Run him on your Mac, shape his character,
and reach the same Clankie from the iPhone and iPad app wherever you are.

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

A Mac release with a published app pin also installs `Clankie.app` in
`/Applications`. Add `--no-app` (`sh -s -- --no-app`) to stay terminal-only;
updates retain that choice. The companion distribution pin is currently gated
on its signed release; see [distribution](docs/distribution.md#mac-companion-app).
Linux and source checkouts do not install it.

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

You drive him. He drives the rest.

**Plans the work.** Hand him an outcome, not a task list. He breaks it into
issues where your repo already tracks work, in Linear, GitHub issues or its own
files, or in his built-in tracker, and keeps the plan true as it moves
([work items](https://docs.clankie.bot/cli/#work-status-work-init-work-list-show-create-update-close-attach-write-receipt)).

**Delegates it.** When a job needs more hands he hires Claude Code, Codex, Pi,
OpenCode, or Grok Build agents into real terminals in Herdr, panes you can
watch and type into, and briefs them through each harness's own channel. Each
project can get its own lead, on your Mac or a linked PC, and leads message
each other directly. New hires go to the account with capacity to spare, and
builds and simulators take turns so a busy fleet doesn't grind your Mac to a
halt ([agent control](packages/agent-hosts/README.md#seat-adapters),
[remote project leads](docs/adr/0259-remote-project-leads-use-seat-bound-delegation.md),
[shared resources](https://docs.clankie.bot/cli/#heavy-seat-label-holder-id-command-args-fleet-resources-simulator)).

**Owns it.** He reads every report, checks it against the evidence, lands the
work, and moves the issue to Done with that evidence attached. Evidence lives
in its own store, not your git history
([evidence store](docs/adr/0258-evidence-lives-in-the-evidence-store.md)).

**Improves how it gets done.** He reviews every worker he leads on a schedule,
flags the stalled and the drifting, and steps in. Per-issue metrics show where
the time and tokens went
([efficiency](https://docs.clankie.bot/cli/#agents-efficiency-agents-tidy-worktrees),
[metrics](https://docs.clankie.bot/cli/#metrics-issues-issue-id-worker-id-since-iso-until-iso)).

**Decides as much as you let him.** One autonomy dial: off, low, high or full.
At high, the default, he answers his workers, decides on changes that are hard
to undo, commits, pushes and closes work, and asks you before a release. Money
and accounts always come to you. Under Advanced, each gate, commit, push,
release rule (even "when the last release is a week old") and close is its own
setting, for every project or just one. When he needs you, he leaves one ask
with his recommendation
([autonomy](https://docs.clankie.bot/cli/#autonomy-dial),
[working preferences](https://docs.clankie.bot/cli/#fleet-status-fleet-set-notes-text-size-size-models-mode-fleet-clear),
[asks](https://docs.clankie.bot/cli/#owner-asks-conversations-questions-id-and-conversations-answer)).

**Has ideas of his own.** He schedules his own wake-ups to pick work back up,
and in his own console he can hold a goal and keep at it within a token budget
you set; a seat in Claude Code or Codex can't hold one. From his own
conversations he can post into your Discord rooms: a find worth sharing, or an
announcement in the server he runs. `/autonomy pause` stops goal runs and
self-wakes; in Discord, chattiness and what wakes him set how readily he jumps
in
([goals](https://docs.clankie.bot/using-clankie/#give-him-ongoing-work)).

**Your right-hand man.** Think out loud with him and get pushed back on, hand
him drafts and pictures to make, and ask what's moving, what's stuck, and what
actually landed. His persona is yours to shape, and his history, memory, and
goals live in the service, so he picks up where you left off on any screen.

**Goes where you are.** Talk to him from his own console, or seat him in Claude
Code or Codex, the terminal you already use. In the iPhone and iPad app,
Messages is home, Commons shows the team as little figures, and Terminal opens
the real worker panes.
[Pair the app](https://docs.clankie.bot/get-started/#bring-your-mac-s-clankie-into-the-app)
with your Mac and keep the Mac awake to reach him away from your desk.

**Hangs out after hours.** In Discord he chats, joins voice, plays requested
music, and streams his Pokémon play (from his own PokeAgents seat) through an
Activity. Screen-share watching and Go Live need the separate personal-lab body
([Discord media](docs/discord-media.md)).

**Is built to extend.** Models, skills, and connected services are independent
choices: Linear, GitHub, Gmail, Google Calendar and Drive, Discord, image and
video generation, and his own browser with his own logins
([browser contract](docs/adr/0082-clankie-holds-the-browser.md)). A headless
CLI, an HTTP API, and an MCP bridge expose the same authorized tools to scripts
and other agents ([customize](https://docs.clankie.bot/diy/)).

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
