# clankie

Clankie is a persistent agent with a
personality: he chats in Discord (text and
voice), plays Pokémon and Minecraft on
stream, makes images and videos, browses the
web, and codes. This repo is his body — one
service (`apps/clankie`) plus the surfaces
that reach it, shared packages, game-world
integrations, and the docs/ADRs that govern
them.

- `apps/` — the service and its surfaces
  (TUI console, Discord bodies, activity
  page, GBA MCP server, relay).
- `packages/` — shared contracts and
  adapters; `protocol` depends on nothing.
- `integrations/` — game-world bodies:
  headless mGBA (Pokémon) and Mineflayer
  (Minecraft), both behind the environment
  adapter contract.
- `docs/` — `architecture.md` plus 49 ADRs
  (0012–0090; gaps are governance-era
  records left in git history).
- `scenarios/` — frozen, hash-pinned gameplay
  verification fixtures; success derives
  from emulator/server state, not claims.
- `scripts/` — doc-link check, `pnpm doctor`,
  launcher install.
- `branding/` — public pixel-art marks;
  integer scaling only.
- `.agents/` — repo-owned skills
  (trace-clankie), symlinked into `.claude/`,
  `.codex/`, `.pi/`.
- `.github/` — CI gate and provider smoke
  workflow.

## Architecture in one arc

One Node service is the only authority:
the pi-based captain runs per-lane sessions
over an authored tool bank, an append-only
JSONL event log feeds projections, and every
surface — Discord bridge, user session,
activity iframe, TUI, relay, MCP — is a body
or a view dialing in with broker-issued
bearers. Secrets live in the Keychain
credential broker, never the repo or env.
Model output is untrusted input; possession
leases keep one mind per body; everything
fails closed and leaves a durable trail.

## Working here

`pnpm typecheck && pnpm test` before handoff;
narrowest check first. CI runs `pnpm check`
on macos-15 with pinned pnpm and Node.
