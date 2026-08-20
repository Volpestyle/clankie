# ADR 0048: One character, two Discord bodies

Status: accepted (James, 2026-07-25). Screen-share watch and Go Live publish,
originally deferred here, shipped through
[ADR 0098 (user-session shares)](0098-user-session-watches-discord-shares.md)
and [ADR 0100](0100-vox-is-an-owned-native-media-package.md). Current-status
addendum (2026-08-19): [ADR 0128](0128-vox-is-the-sole-discord-media-owner.md)
governs the one child and role-specific media lifecycle for either
media-enabled active body; text-only official-bot mode spawns no child. This
ADR's one-active-body, credential isolation, opt-in, and allowlist decisions
remain in force. References to doctrine and deployment profiles describe the
retired implementation at ratification.

## Context

[ADR 0024](0024-discord-dual-plane-presence.md) reserved `user_session` as an
isolated transport. A bot cannot Go Live or participate as a normal member in a
friend's server, while character, lane continuity, consent, and receipts are
not properties of a Discord credential.

Discord forbids automating normal user accounts. This body is therefore an
explicit personal-lab capability, never the supported default.

## Decision

### Runtime binding, not character fork

`DiscordTransportKind` names which credential opened the gateway. Action
contracts remain transport-neutral and declare which bodies can perform them.
Exactly one configured body is active: the launcher starts either the official
bot or `apps/discord-user-session`, and voice/media attach to that one mouth.

![ADR 0048 Discord user-session transport](../diagrams/0048-discord-user-session-transport.jpg)

[Editable Turbopuffer tldraw source](../diagrams/clankie-docs-diagrams.tldraw)

| Action family                                | Bot | User session |
| -------------------------------------------- | --- | ------------ |
| text, reactions, threads, voice, attachments | yes | yes          |
| screen-share watch and `go_live_*`           | no  | yes          |
| embedded `activity_*`                        | yes | no           |

Lane identity derives from the room (`discord:<guild|dm>:<channel>`), never the
transport. Switching bodies therefore continues one character and one
conversation scope.

### Isolation and admission

The user body is a separate process and never imports or receives the bot
credential. It reaches the normal-user token only after three fail-closed gates:

1. explicit enablement plus non-empty allowlists;
2. a durable, revocable owner opt-in whose recorded scope cannot be widened by
   configuration; and
3. a brokered `discord_user_session` credential, resolved last.

At ratification a fourth doctrine/profile gate also existed and the opt-in was
bound to its hash. That policy subsystem has since been removed; this is
historical rationale, not a current setup requirement.

Transport identity is bound to the authenticated local bearer, never accepted
from the request body. Each process loads only its own privileged executor.

## Alternatives considered

- **A mode flag in the bot process** was rejected because it would place both
  credentials in one process image.
- **Duplicate the participation stack** was rejected because consent, capture,
  and lane addressing would drift.
- **Self-declared transport in action payloads** was rejected because it would
  be a privilege-escalation path.

## Consequences

- One active body owns the mouth and media session.
- The user body has no slash commands and cannot request broad channel history.
- Watch and publish are implemented, but account and ToS risk remains the
  owner's explicit choice.
- Current setup, configuration, and live proof belong in the
  [user-session operating guide](../../apps/discord-user-session/README.md).
