# ADR 0024: Dual Discord planes and transport-agnostic presence

Status: accepted (James, 2026-07-11; Go Live/user-session scope confirmed 2026-07-12 in
VUH-751). P1 **outbound** bot-transport policy path implemented.

## Context

Clankie ships an official-bot ambient surface in `apps/discord-bridge`: slash commands,
mission-thread projection, role-bound ambient authority, and a bot-only ClankVox voice
path ([ADR 0025](0025-clankvox-placement-and-ipc.md)). A second need is a **social body**
(react, reply, images, voice, educational Go Live / livestream). Go Live requires a
**user session**; the bot remains useful for limited ambient capability.

Captain lanes must stay **bounded-turn surfaces** (Linear channel-turn pattern), not
gateway event firehoses, so Clankie can sit in voice/Minecraft while orchestrating missions.

## Decision

### Go Live and user-session media are a v2 capability

Clankie v2 keeps Go Live watch and publish as an explicitly enabled, isolated
**personal-lab capability**. It is product scope, but it is not a recommended deployment path,
team feature, launch criterion, or extension of the official-bot media session. Discord forbids
automating normal user accounts, so high-assurance and team doctrine profiles deny the capability.
An owner must deliberately enable the lab profile, accept the current account and maintenance
risk, constrain credentials to the credential broker, and record the opt-in before the separate
user-session process connects.

This boundary keeps the social value—Clankie can watch a friend's stream, discuss bounded sampled
frames, or share an owned/rendered surface—without making reverse-engineered transport a dependency
of core voice. The official API cannot provide these operations to a bot. The implementation cost
therefore remains conditional and independently gated: transport isolation, consent, publish
approval, resource budgets, media correctness, and live official-client evidence must each pass
before a particular Go Live path is usable.

### Dual planes, one character

| Plane | Process | Auth | Role |
| --- | --- | --- | --- |
| Ambient bot | `apps/discord-bridge` | Official bot token | Slash, mission threads, ambient steer |
| Presence body | bot runtime plus isolated opt-in user-session runtime | Transport binding `bot` \| `user_session` | Catalog actions via policy; user session is personal-lab only |

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
| P2 user_session transport | **kept follow-up** — VUH-836, isolated personal-lab runtime |
| P3 Go Live watch media | **kept follow-up** — VUH-840, bounded sampled observations |
| P3 Go Live publish media | **kept follow-up** — VUH-841, governed video playback/rendered surfaces |
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
- User-session credentials, Go Live media, and inbound channel turns remain out of P1. They are
  retained in v2 through separately gated follow-ups rather than folded into the bot executor.
- VUH-836 owns the secondary user-session process, credential isolation, explicit opt-in event,
  deny-by-default profiles, and the invariant that bot and user-session transports never co-own a
  voice/media session.
- VUH-840 owns stream receive, consent and ephemeral retention, bounded frame sampling into vision
  turns, and receive-side DAVE/keyframe/RTX recovery evidence. Its media boundary uses capped,
  versioned binary frame IPC; raw video never enters semantic event streams.
- VUH-841 owns stream publish, including paced audio/video publication, YUV-native frames through
  encode and IPC boundaries, send-side DAVE/keyframe/RTX correctness, operator-available stop, and
  official-client live evidence. External content passthrough remains a separate rights/ToS
  decision; this decision covers owned artifacts and Clankie-rendered surfaces.
- VUH-246 remains canceled legacy evidence for the v1 investigation. VUH-840 and VUH-841 define
  new v2 execution and do not reopen that historical ticket.
- Former dual ADR `0020` for ClankVox is renumbered to [ADR 0025](0025-clankvox-placement-and-ipc.md).
