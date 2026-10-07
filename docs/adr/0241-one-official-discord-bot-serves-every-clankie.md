# ADR 0241: One official Discord bot serves every Clankie

Status: Accepted (2026-10-06, James; VUH-1372 decision comment). Implemented by
VUH-1766 (free self-hosted route) and VUH-1765 (wake trigger and ambient chat).
Builds on [ADR 0183](0183-the-harness-is-public-the-hosted-service-is-private.md)
and [ADR 0227](0227-discord-connects-a-server-with-a-role.md).

## Decision

1. **James's existing bot is the official app**, and it serves hosted tenants and
   free self-hosted installs alike. A self-hosted machine signed in with its
   Clankie account adds it with one Add to Discord, without a developer portal,
   bot token or intents setup. Creating your own bot stays as the advanced path.
2. **The token stays on the hosted edge.** A self-hosted machine registers a
   P-256 ingress key with its account and receives the same sealed,
   fleet-permitted events a hosted body does, through the gateway connection it
   already keeps. It never holds the official token, and one bot token has one
   gateway connection: a machine whose own bot is the official app must stop
   running it before switching.
3. **Authority stays local.** On the self-hosted route the edge's owner flag
   grants nothing; the machine's own Discord settings decide who gets tools,
   exactly as with a bring-your-own bot.
4. **Free is Discord delivery only**, with per-account and per-server limits on
   admitted messages, wakes and sends, and operator blocks that say why. Every
   free install acts under the official bot's standing, so limits and blocking
   are part of the feature. No hosted body, included model usage, voice or other
   paid-plan feature.
5. **Wake on a configurable trigger.** `discord.wakeTrigger` is `addressed`,
   `name` or `any`. Hosted defaults to `addressed`, because hosted wakes cost the
   tenant's budget. Self-hosted leaves it unset, which keeps today's behavior:
   `persona.replyPolicy` decides and he considers every admitted message by
   default. No feature is lost.
6. **Ambient chat is opt-in per channel.** For hosted and official-bot channels a
   server admin opts in, the edge keeps a short encrypted buffer, and a wake
   carries it as context. Buffered chat never wakes or charges anyone by itself.

## Consequences

- `@clankie/protocol/official-discord` carries the registration and status
  contract; `discord-ingress` gains the `message` kind and bounded `context`.
- The body's `GET`/`POST /v1/discord/official` reports the fleet's status and
  turns the route on and off without a restart. The app and
  `clankie discord official` both use it; the contract stays node-free so the app
  can import it.
- Message Content is privileged: past 100 servers the official app needs Discord
  verification and approval for the intent, which is James's step and not
  guaranteed. Without it ambient buffering is inert; addressed chat is unaffected.
- One abusive free install can affect the bot's standing until a limit or block
  stops it. Blocks are manual.

## Rejected

- **A separate official app for free users.** Two bots in the same servers, and
  James's Mac would still share a token with the hosted edge.
- **Waking hosted bodies on every message.** Hosted budget; the owner can still
  choose `any`.
- **Changing the self-hosted default to `addressed`.** It would take away the
  Clankie who reads the room by default.
