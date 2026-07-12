# ADR 0026: Private command-center product monorepo

Status: accepted.

## Context

The agent OS monorepo is intended to be open source (Apache-2.0). The free
graphical command center — Expo mobile shell, bare macOS shell, shared RN UI,
garden pixel art, and the sprite pipeline — is proprietary product surface even
though binaries may be free. Leaving that tree in the public monorepo (or its
git history) would publish product UI and art.

## Decision

1. Product UI and art live only in private **`Volpestyle/clankie-app`**.
2. This monorepo keeps the agent OS and public contracts
   (`@clankie/protocol`, `@clankie/terminal-protocol`, `@clankie/garden-model`).
3. Public release of this monorepo uses an orphan day-zero commit so proprietary
   paths never appear in public history.
4. Public `branding/` may retain README logos only; masters and garden art stay
   private.

## Consequences

- App port / shell work write scope is `clankie-app` (Linear label `clankie-app`).
- ADR 0009 remains valid for RN version lanes but applies in the product repo.
- Agents must not reintroduce `apps/mobile`, `apps/macos`, or
  `packages/command-center` into this monorepo.
