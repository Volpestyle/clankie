# clankie

Clankie is a persistent agent that chats in Discord, works from an operator console, creates media and diagrams, browses, remembers people, and plays games live. One TypeScript service owns the Pi captain, HTTP API, memory, tools, and GBA play host; transport-specific apps surround it, with native Discord media isolated in the AGPL Vox process behind an Apache client boundary.

- `.agents/` — source for repository-owned agent skills.
- `.claude/` — Claude compatibility links and settings.
- `.codex/` — Codex compatibility links.
- `.editorconfig` — editor whitespace defaults.
- `.github/` — issue/PR templates and CI workflows.
- `.gitignore` — generated, local-state, credential, and operator-only exclusions.
- `.node-version` — Node toolchain pin.
- `.npmrc` — npm/pnpm behavior.
- `.nvmrc` — shell Node-version pin.
- `.oxfmtrc.json` — Oxfmt formatting policy.
- `.pi/` — Pi captain skill compatibility root.
- `AGENTS.md` — repository map, trust rules, and verification contract.
- `CLAUDE.md` — compatibility link to `AGENTS.md`.
- `CONTRIBUTING.md` — contributor setup and checks.
- `LICENSE` — Apache-2.0 repository license.
- `NOTICE` — project attribution notice.
- `README.md` — product overview and operating entrypoints.
- `SECURITY.md` — security boundaries, reporting, and containment.
- `THIRD_PARTY_NOTICES.md` — vendored and interoperated dependency notices.
- `apps/` — service plus operator, Discord, activity, GBA MCP, relay, and Vox executables.
- `branding/` — public logos and banner assets.
- `docs/` — current architecture, credentials/media guides, ADRs, and diagrams.
- `integrations/` — GBA emulator and Minecraft Paper verifier integrations.
- `oxlint.json` — repository lint policy.
- `package.json` — root scripts, metadata, and toolchain versions.
- `packages/` — shared contracts, adapters, runtimes, configuration, and process clients.
- `patches/` — narrow pnpm dependency patches.
- `pnpm-workspace.yaml` — workspace membership and dependency overrides.
- `scenarios/` — immutable GBA verification fixtures.
- `scripts/` — documentation, doctor, and CLI-install utilities.
- `tsconfig.base.json` — strict shared TypeScript policy.
- `tsconfig.json` — root TypeScript project references.
- `turbo.json` — workspace task graph and cache policy.
- `vitest.config.ts` — repository-wide test configuration.

Surfaces authenticate into `apps/clankie` on loopback port 4310. The service composes brokered credentials, owner-authored settings/persona, Pi sessions, memory, browser/media/drawing tools, Discord projections, device pairing, and GBA embodiment; PokeAgent MMO remains external behind its packaged MCP server rather than becoming another in-process world integration.

Model, Discord, media, browser, and provider content is untrusted. Authority comes from host-stamped lanes and caller credentials, voice never receives a shell, one active Discord body owns its gateway, and body locks prevent concurrent control of the same game surface.
