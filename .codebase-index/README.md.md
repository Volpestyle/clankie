# README.md

The repo's front door. Introduces Clankie — a
persistent agent with a personality who chats in
Discord (text and voice), plays Pokemon and
Minecraft on stream, generates images/video,
browses, codes, and leads herdr agent fleets —
and gives the quickstart plus an app map.

Sections:

- What he does: Discord teammate, games on a
  watch surface, media generation, coding and
  fleet leadership, one persona across all rooms.
- Get started: Node 24+, pnpm 11+; `pnpm install`,
  `pnpm doctor`, `pnpm cli:install`, then run
  `clankie` to start the service and TUI. Secrets
  live in the credential broker (Keychain), never
  `.env`; configure via TUI slash commands
  (`/auth`, `/model`, `/image-model`, `/persona`).
- Apps table: apps/clankie (the service, API on
  :4310), tui, discord-bridge,
  discord-user-session, discord-activity, gba-mcp,
  relay; plus integrations/ and packages/.
- Development commands (`pnpm check`,
  `gba:free-play`, `discord:readiness`) and
  pointers to docs/architecture.md and AGENTS.md.
- License: Apache-2.0.

Header embeds branding/clankie-logo-512.png.
