# clankie

Clankie is a persistent TypeScript agent that chats in Discord, works from an operator console, creates media and diagrams, browses, remembers people, and plays Pokémon live. One authoritative `apps/clankie` service owns the Pi captain, HTTP boundary, memory, tools, and asked-play host; transport-specific apps surround it. The Node 24 + pnpm + Turbo monorepo keeps cross-process schemas in dependency-light packages and game bodies behind governed adapters.

- `.agents/` — real source for the repo-owned `trace-clankie` skill.
- `.claude/` — Claude Code compatibility links to repo-owned skills.
- `.codex/` — Codex compatibility links to repo-owned skills.
- `.editorconfig` — editor whitespace defaults.
- `.github/` — CI and provider smoke workflows.
- `.gitignore` — generated, local-state, credential, and operator-only exclusions.
- `.node-version` — Node 24 toolchain pin.
- `.npmrc` — pnpm/npm workspace behavior.
- `.nvmrc` — Node 24 shell-version pin.
- `.oxfmtrc.json` — Oxfmt formatting policy.
- `.pi/` — Pi captain skill compatibility root.
- `AGENTS.md` — repository map, trust rules, and verification contract for agents.
- `CLAUDE.md` — compatibility link to `AGENTS.md`.
- `CONTRIBUTING.md` — contributor setup and change checks.
- `LICENSE` — Apache 2.0 license.
- `NOTICE` — attribution notice.
- `README.md` — product overview, setup, app map, and development entrypoints.
- `SECURITY.md` — vulnerability reporting and secret-handling policy.
- `THIRD_PARTY_NOTICES.md` — dependency and bundled-component notices.
- `apps/` — service plus TUI, Discord, activity, GBA MCP, and relay surfaces.
- `branding/` — public pixel-art logos and banner.
- `docs/` — current architecture overview, ADRs, and diagram sources/renders.
- `integrations/` — GBA emulator and Minecraft Mineflayer environment adapters.
- `oxlint.json` — repository lint rules.
- `package.json` — root scripts, toolchain versions, and workspace metadata.
- `packages/` — shared contracts, security/config adapters, runtimes, and transport seams.
- `patches/` — narrow pnpm dependency patches.
- `pnpm-workspace.yaml` — workspace membership and dependency overrides.
- `scenarios/` — immutable, digest-pinned gameplay verification fixtures.
- `scripts/` — docs check, doctor, and CLI installer utilities.
- `tsconfig.base.json` — strict shared TypeScript policy.
- `tsconfig.json` — root project references.
- `turbo.json` — workspace task graph and cache policy.
- `vitest.config.ts` — repository-wide test discovery and execution config.

## Architecture

Surfaces authenticate into `apps/clankie` on localhost port 4310. The service resolves owner-authored persona/settings, brokered credentials, Pi sessions, bounded memory, browser/media/tldraw hosts, Discord projections, device pairing, and embodiment; `@clankie/protocol` and `@clankie/interactive-environment` define the strict process boundaries beneath it.

Game actions flow through single-writer leases and a cross-process GBA body lock. Model, Discord, attachment, browser, and provider content is untrusted; authority comes from host-stamped lanes and caller credentials, voice never receives a shell, and only allowlisted Discord text actors receive machine tools.

The root `pnpm check` gate runs format, lint, documentation links, typecheck, and tests. `docs/architecture.md` is the narrative system map and `docs/adr/` records active decisions.
