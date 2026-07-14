# ADR 0024: Dual Discord planes and transport-agnostic presence

Status: accepted (James, 2026-07-11; Go Live/user-session scope confirmed 2026-07-12 in
VUH-751). P1 outbound, P2 bounded text ingress, and the bot presence lifecycle are implemented.

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

| Plane         | Process                                               | Auth                                      | Role                                                          |
| ------------- | ----------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------- |
| Ambient bot   | `apps/discord-bridge`                                 | Official bot token                        | Slash, mission threads, ambient steer                         |
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

| Family                                        | Class                                  |
| --------------------------------------------- | -------------------------------------- |
| reply, react, unreact, send_message, typing   | `narrative-write` (shared rate ledger) |
| edit/delete own, thread ops, voice join/leave | `reversible-write`                     |
| attachment, go_live                           | `publish-external`                     |

### Phasing

| Phase                                                                                     | Status                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR + protocol stubs                                                                      | done                                                                                                                                                                                                                                                                                                                                                                      |
| **P1 outbound bot-transport** via `POST /v1/discord/presence-actions` + bot REST executor | **done** — policy-gated catalog execution only; not free-form DM/chat ingress                                                                                                                                                                                                                                                                                             |
| **P1.5 publish-external completion**                                                      | Attachments follow `require_approval` → bounded `ApprovalRequest` → authenticated resume → exact-idempotency-key re-execution. Denied and expired requests remain terminal. Approval records and semantic events retain only the artifact reference and write hash; the privileged bot runtime resolves and verifies bytes. Go Live remains unavailable on bot transport. |
| **P2 ingress** (channel-turn / DM / mention → Eve bounded turn)                           | **implemented** — explicit opt-in Message Content intent, deny-by-default guild/channel and DM policy, Discord text only in ephemeral Eve `clientContext`, a content-free durable message, no retained continuation cursor, authenticated `discord_presence` lane addressing, and policy-gated reply. Live bot verification remains a separate gate.                      |
| P2 user_session transport                                                                 | **kept follow-up** — VUH-836, isolated personal-lab runtime                                                                                                                                                                                                                                                                                                               |
| P3 Go Live watch media                                                                    | **kept follow-up** — VUH-840, bounded sampled observations                                                                                                                                                                                                                                                                                                                |
| P3 Go Live publish media                                                                  | **kept follow-up** — VUH-841, governed video playback/rendered surfaces                                                                                                                                                                                                                                                                                                   |
| P4 mission coupling                                                                       | later                                                                                                                                                                                                                                                                                                                                                                     |

Ambient turns without mission coupling carry a stable `presenceSessionId`. Narrative writes use that first-class scope for rate and correlation attribution; they do not fabricate mission events. Non-narrative writes continue to require real mission attribution.

### Session phase

The Discord bridge owns the bot presence session record. Discord gateway and bot voice-state
callbacks drive `off → connecting → present → voice_active` and the `degraded` / `failed`
loss states. Every transition is published as a typed
`discord.presence.session.phase_changed` semantic event through the authenticated ambient
captain channel. The control plane replays those events into a read-only projection and gates
catalog execution and tool exposure from the projected record. The bridge also carries its
presence session id, phase, and monotonic revision as a typed claim on each authenticated action
request. The control plane advances its latest validated live-session watermark before awaiting
durable publication and requires the action claim to match that watermark exactly. Immediate loss
therefore fences execution while durable publication is still in flight, and a pre-loss claim
cannot be replayed through that window. After a control-plane restart, durable session replay
restores status but leaves act gating unvalidated until a fresh authenticated lifecycle delivery
re-establishes the live watermark. Both the live claim and durable projection must permit the
action. Payload kinds never infer or widen phase.

`degraded`, `failed`, and `off` remove act tools immediately. A disconnect, lease loss, or
failure therefore makes subsequent actions unavailable without waiting for another model turn.
Phase publication retries transient transport failures with bounded backoff. Permanent rejection
or an exhausted retry budget terminates the local session in `failed`, emits a typed local semantic
failure event for status reporting, and logs the classified terminal outcome without wedging the
lifecycle queue.
`discordPresencePhaseFromEnvironment` and `environmentPhaseFromDiscordPresence` define the
provider-neutral adapter for a shared environment join/status host. The current Discord bridge
uses its dedicated presence lifecycle tools because no production shared join/status host exists;
the adapter remains the required boundary when that host is introduced.

## Consequences

- The control plane classifies presence actions, narrative writes share the tracker rate
  ledger (content may be omitted and derived for react/typing), publish-external stops at
  doctrine decision without approval minting (explicit debt), bot executor lives in
  `apps/discord-bridge` and loads via `CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE`.
- The bridge-to-control-plane phase stream is the status authority. ANSI output and action
  payloads are not lifecycle signals; the TUI renders phase directly from retained semantic events.
- User-session credentials and Go Live media remain separately gated follow-ups rather than being folded into the bot executor.
- P2 text ingress requests Message Content only under explicit configuration, fetches bounded context only after admission, keeps Discord text in Eve's ephemeral `clientContext` rather than durable session history, excludes raw message bodies from ingress evidence, and returns settled text through the existing bot presence policy path.
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
