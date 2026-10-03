# Contributing

This repository contains Clankie's open-source service, terminal console,
relay, and shared contracts. Start with the [architecture](docs/architecture.md)
and [library map](docs/README.md) to find the part you want to change.
[AGENTS.md](AGENTS.md) contains the repository's engineering rules.

## Run from source

Use Node 24+, pnpm 11+, Git, Rust 1.88+, and CMake. Native Mac components need
Apple's command-line developer tools. The normal desktop setup targets Apple
silicon and macOS 14 or newer; Linux operators should follow the
[separate deployment guide](infra/hosted/README.md).

```sh
corepack enable
pnpm install
pnpm doctor
pnpm cli:install
clankie
```

`pnpm cli:install` links the launcher into `~/.local/bin`. If agents edit this
checkout while Clankie runs from it, use `pnpm cli:install --pinned` instead: the
launcher and the service it starts then run from a detached worktree at `main`
(`~/.clankie/pinned`, with its own install), so uncommitted edits or a stale
`node_modules` here cannot break them. Rerun it after landing to move the
runtime forward, then `clankie restart all`. Choose local mode
and complete `/setup`; credentials go through the broker. Source checkouts use
the same onboarding as the [installed bundle](https://docs.clankie.bot/get-started/).
Do not commit credentials or local settings.

## Make and verify a change

Keep one logical concern per pull request. Preserve unrelated work in a shared
checkout and follow the repository's branch/worktree instructions. Match the
surrounding code; start with the narrowest relevant check, then run the final gate:

```sh
pnpm check
```

That gate covers formatting, lint, unused code, documentation links and build,
infrastructure validation, TypeScript, and tests. Update meaningful coverage when
behavior changes. A documentation-only change should at least build the docs and
verify its links before the full gate:

```sh
pnpm docs:check
pnpm docs:public:build
```

Preview the built site through a local HTTP server; its links are root-relative.
The [docs app guide](apps/docs/README.md) gives the command and source map.

## Keep the boundaries clear

- The [CLI contract](docs/cli.md), OpenAPI catalog, and owning package references
  are canonical. Update their sources, not generated docs in `apps/docs/dist`.
- Put current user guidance in the docs site and implementation details in the
  owning module or technical guide. Link instead of maintaining duplicate explanations.
- Keep historical ADRs and dated test evidence historical. Record consequential
  decisions using the [ADR conventions](docs/adr/README.md).
- Companion-app source belongs in `clankie-app`; managed-service deployment,
  accounts, and production records belong in `clankie-ops`.

Describe the problem, resulting behavior, and verification plainly in the pull
request. Say what was tested and what remains unverified.
