# ADR 0024: Dual Discord planes and transport-agnostic presence

Status: accepted (James, 2026-07-11). P1 **outbound** bot-transport policy path implemented.

## Context

Clankie ships an official-bot ambient surface in `apps/discord-bridge`: slash commands,
mission-thread projection, role-bound ambient authority, and a bot-only ClankVox voice
path ([ADR 0025](0025-clankvox-placement-and-ipc.md)). A second need is a **social body**
(react, reply, images, voice, educational Go Live / livestream). Go Live requires a
**user session**; the bot remains useful for limited ambient capability.

Captain lanes must stay **bounded-turn surfaces** (Linear channel-turn pattern), not
gateway event firehoses, so Clankie can sit in voice/Minecraft while orchestrating missions.

## Decision

### Dual planes, one character

| Plane | Process | Auth | Role |
| --- | --- | --- | --- |
| Ambient bot | `apps/discord-bridge` | Official bot token | Slash, mission threads, ambient steer |
| Presence body | bot runtime now; user_session later | Transport binding `bot` \| `user_session` | Catalog actions via policy |

Invariants: no shared gateway for bot+user tokens; models never hold Discord credentials;
ambient ingress cannot approve privileged actions; outbound actions use
`ActionRequest → doctrine → privileged connector`.

### Lane `discord_presence`

Ambient authority tier. Bounded channel turns only.

### Transport-agnostic capability catalog

Action schemas (reply, react, send_attachment, voice_join, go_live_*) do not know bot vs
user. Runtime binding + phase + doctrine select availability. Go Live requires
`user_session`.

### Doctrine risk classes

| Family | Class |
| --- | --- |
| reply, react, unreact, send_message, typing | `narrative-write` (shared rate ledger) |
| edit/delete own, thread ops, voice join/leave | `reversible-write` |
| attachment, go_live | `publish-external` |

### Phasing

| Phase | Status |
| --- | --- |
| ADR + protocol stubs | done |
| **P1 outbound bot-transport** via `POST /v1/discord/presence-actions` + bot REST executor | **done** — policy-gated catalog execution only; not free-form DM/chat ingress |
| **P1.5 publish-external completion** | **follow-up** — today `require_approval` for attachment/go_live returns 403 without minting an approval-store request; wire `require_approval` → `ApprovalRequest` → authenticated resume → re-execute before attachments can succeed |
| **P2 ingress** (channel-turn / DM / mention → Eve bounded turn) | **next explicit task** — `DiscordPresenceChannelTurnRequestSchema` is frozen for this path but not yet consumed by a gateway handler or control-plane turn route |
| P2 user_session transport | later |
| P3 ClankVox Go Live media | later |
| P4 mission coupling | later |

P1 does **not** deliver “DM Clankie and he responds.” That is P2 ingress.

### Session phase (P1 pin)

P1 bot executor pins catalog phase to `present` and does not invent phase from the payload
kind (which would self-fulfill voice/go_live gates). P2+ must supply phase from durable
presence session state.

## Consequences

- P1: control plane classifies presence actions, narrative writes share the tracker rate
  ledger (content may be omitted and derived for react/typing), publish-external stops at
  doctrine decision without approval minting (explicit debt), bot executor lives in
  `apps/discord-bridge` and loads via `CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE`.
- User tokens, Go Live, and inbound channel turns remain out of P1.
- Former dual ADR `0020` for ClankVox is renumbered to [ADR 0025](0025-clankvox-placement-and-ipc.md).
