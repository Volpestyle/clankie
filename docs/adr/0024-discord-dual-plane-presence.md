# ADR 0024: Dual Discord planes and transport-agnostic presence

Status: accepted (James, 2026-07-11; Go Live/user-session scope confirmed
2026-07-12 in VUH-751). Amended by
[ADR 0048](0048-discord-user-session-transport.md),
[ADR 0098 (user-session shares)](0098-user-session-watches-discord-shares.md),
and [ADR 0100](0100-vox-is-an-owned-native-media-package.md). The mission,
doctrine, approval, and deployment-profile vocabulary below records the system
at ratification; those mechanisms are not part of the current architecture.

## Context

At ratification `apps/discord-bridge` was an official-bot ambient surface with
bounded text turns, mission-thread projection, role-bound commands, and group
voice. The desired social body also needed reactions, replies, attachments,
voice, and educational Go Live. Discord exposes Go Live only to a normal-user
session, while the bot remains the supported default for text, voice, and
activities.

Gateway traffic also needed to become bounded captain turns rather than an
unbounded event firehose. Discord content is untrusted input regardless of
which credential observed it.

## Decision

### Two transports, one character

Bot and normal-user credentials live in separate processes and never share a
gateway. Conversation identity derives from the room, not the transport, so
switching bodies does not fork the character or lane history.

| Body                      | Process                     | Credential         | Role                                                 |
| ------------------------- | --------------------------- | ------------------ | ---------------------------------------------------- |
| Official bot              | `apps/discord-bridge`       | official bot token | text, voice, and embedded activities                 |
| Personal-lab user session | `apps/discord-user-session` | normal-user token  | text, voice, screen-share watch, and Go Live publish |

[ADR 0048](0048-discord-user-session-transport.md) later made exactly one body
active at a time. [ADR 0098 (user-session shares)](0098-user-session-watches-discord-shares.md)
and [ADR 0100](0100-vox-is-an-owned-native-media-package.md) shipped the
previously deferred screen-watch and publish media path through Vox.

### Go Live is isolated personal-lab capability

Normal-user automation violates Discord's terms. The user-session body is
therefore off by default, owner-opted-in, allowlisted, broker-credentialed, and
isolated from the official bot. It is not a team deployment path or a
prerequisite for bot voice.

The supported default for showing Clankie-rendered surfaces is the Discord
activity plane in [ADR 0047](0047-discord-activity-presence-plane.md). The user
session covers what a bot activity cannot: watching another user's share and
publishing through Go Live.

### Capabilities are transport-neutral

Reply, reaction, attachment, voice, activity, and Go Live schemas do not carry
credentials or select a transport. The authenticated body and its live session
determine which actions exist. Models never receive Discord credentials or
choose raw gateway identity.

The bridge publishes a typed live-session phase and revision. Requests must
match the authenticated body's latest live claim, so disconnect, restart, or
lease loss fences later actions without trusting a model-supplied phase.

### Historical rollout

The initial implementation projected presence actions through doctrine risk
classes, mission correlation, approval envelopes, and deployment profiles.
Those systems were later retired. Their enduring boundary is narrower and
still current: ambient Discord input cannot grant machine authority, arbitrary
identity and destination values are host-grounded, and privileged capabilities
remain unavailable to ordinary room participants.

Go Live receive and publish were originally recorded as VUH-840/VUH-841 future
work. They are no longer future work; the shipped decisions and operating guide
are linked above and in the
[user-session README](../../apps/discord-user-session/README.md).

## Alternatives considered

- **One process holding both credentials** was rejected because a mode flag is
  not credential or gateway isolation.
- **Make normal-user transport the default** was rejected because its account
  and maintenance risk is inappropriate for the supported bot path.
- **Put raw gateway events into captain sessions** was rejected because it
  creates unbounded, transport-shaped context instead of bounded turns.

## Consequences

- The official bot and lab body share participation contracts without sharing
  credentials or a gateway.
- Exactly one active body owns voice and media, preventing two mouths in one
  room.
- Account and ToS risk remains an explicit owner choice even though watch and
  publish are implemented.
- Current setup and live-proof commands belong in the
  [bot bridge](../../apps/discord-bridge/README.md) and
  [user-session](../../apps/discord-user-session/README.md) operating guides.
