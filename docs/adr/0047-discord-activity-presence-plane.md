# ADR 0047: The Discord activity plane carries Clankie's rendered video

Status: accepted (James, 2026-07-25). The activity app, frame transport, and
live Discord evidence are implementation gates.

## Context

Clankie plays and talks in the same Discord room through separate surfaces.

He plays: the pinned headless mGBA core drives an operator-supplied FireRed ROM
and decodes overworld position, party records, legal moves, bag, dialog, menus,
and battle outcome from RAM ([ADR 0040](0040-real-mgba-core-behind-the-emulator-seam.md),
[ADR 0043](0043-version-pinned-firered-gameplay-profile.md)). He talks: the
official bot holds a DAVE group-voice session with brokered speech
([ADR 0045](0045-official-bot-dave-group-voice.md)).

The activity plane carries `MgbaFireRedCore.framebufferSnapshot()` RGB565 frames
to humans in the voice channel without moving the ROM, core, or savestate.

**Discord blocks video publication from bot accounts.** This is a gateway-level
restriction, not a missing library. Every Go Live implementation — the
Discord-RE fork, `@dank074/discord-video-stream`, and the republished
derivatives — takes a selfbot library as a peer dependency and requires a raw
user-account token. The published request to lift this for bots
(`discord/discord-api-docs#1603`) remains open, and the March 2026
move to end-to-end encrypted calls everywhere raises the maintenance cost of
reverse-engineered transports further.

[ADR 0024](0024-discord-dual-plane-presence.md) scopes Go Live as an
explicitly opted-in, isolated **personal-lab** capability, denied by the
high-assurance and team doctrine profiles. This ADR does not relax that boundary.

Discord Activities provide the officially supported rendered surface for a
voice channel.

## Decision

Clankie gains a third presence plane: the **activity plane**, built on Discord's
Embedded App SDK. Activities are web apps hosted in an iframe inside a voice
channel. They are open to all developers, they run on bot transport, and they
require no user-account token.

![ADR 0047: The Discord activity plane carries Clankie's rendered video](../diagrams/0047-discord-activity-presence-plane.jpg)

The bot launches the activity through the documented invite endpoint —
`POST /channels/{channel.id}/invites` with `target_type: 2`
(`EMBEDDED_APPLICATION`) and `target_application_id`. No unofficial transport
is involved at any point.

### The plane table

| Plane         | Process                                        | Auth                    | Role                                                    |
| ------------- | ---------------------------------------------- | ----------------------- | ------------------------------------------------------- |
| Ambient bot   | `apps/discord-bridge`                          | Official bot token      | Slash, mission threads, ambient steer                   |
| Presence body | bot runtime plus isolated user-session runtime | `bot` \| `user_session` | Catalog actions via policy; user session is lab-only    |
| Activity      | `apps/discord-activity` plus the bot launcher  | Official bot token      | Rendered surfaces and bounded viewer input in a channel |

The activity plane is the **default** path for showing a rendered surface. The
user-session Go Live plane remains available for what activities genuinely
cannot do — watching _someone else's_ stream — and stays personal-lab gated.
Neither plane is a prerequisite for the other.

### Activity state is a facet, not a rung

`DiscordPresenceSessionPhaseSchema` is an ordered ladder of connection liveness
(`off → connecting → present → voice_active → go_live_active`) and
`isDiscordPresenceActionAvailable` compares rank to a per-action `minPhase`.

Running activities do **not** join that ladder. A running activity and a running
Go Live stream are orthogonal — either, both, or neither may be true while the
session sits at `voice_active` — so ordering them against each other would force
one slot to carry two unrelated meanings and would make "is an activity running"
unanswerable whenever Go Live is also active.

Activity instances are therefore a separate facet on the session record, gated
by `minPhase: voice_active`. `activity_stop` additionally requires a running
instance rather than a higher phase.

`go_live_active` remains phase-modelled. VUH-841 tracks extracting it into the
same orthogonal facet model when the publish path is available.

### The frame transport boundary

The core stays on the host. The ROM, the WASM core, and the savestate never
cross the transport — only encoded frames do. This preserves the pinned-digest
fail-closed model, keeps copyrighted bytes off every client, and keeps the
existing two-fresh-core byte-identical live receipt meaningful.

The seam is versioned and bounded: a capped encoded frame size and a capped
in-flight queue. GBA output is 240×160 flat-palette pixel art that compresses
hard, so per-frame PNG through the existing RGB565 unpack in
`integrations/gba-emulator/scripts/png-writer.ts` is sufficient at hardware rate:
measured on the FireRed bedroom state, one frame is 3.2KB of base64 and 1.68ms of
encode, so 60fps costs ~0.19 MB/s and ~10% of a core. WebCodecs remains the
upgrade path only if the frame budget ever stops holding.

The watched stream runs at hardware rate whether or not he is acting. His own
cadence is bursty — he advances the core in `advanceFrames` bursts and then
thinks — but a stream that mirrors that cadence is a still image two thirds of
the time (measured: 379 emulated seconds over 1143 wall-clock seconds on the
2026-08-15 run), which reads as a crash rather than as thought. The play host
therefore idles the core between turns with nothing held, which is what standing
still in FireRed looks like, and observes every frame rather than every third
one. The frames the watcher sees are the frames the console draws.

This buys continuity at the cost of reproducibility: an idling core advances the
game's RNG, so a live playthrough is not replayable frame-for-frame from
its start state. The competence benchmark keeps determinism because it drives
`createFreePlaySession` directly and never installs the idle tick.

**The core seam's input methods are asynchronous, and that is load-bearing.**
Pacing a watched action with `Atomics.wait` stops the process even though it is
precise and costs no CPU: the current 600-frame benchmark fires 0 of roughly 731
timer ticks during the action. Frames cannot flush, and the HTTP API, Discord
turn, and voice seam also freeze. Awaiting a timer leaves the loop free (599 of
roughly 628 ticks) and, paced against a deadline rather than per chunk, runs an
action in the console's wall-clock time instead of 16% over. Therefore
`pressButton`, `advanceFrames`, and
`advanceFramesHolding` return promises; `EnvironmentRuntime` dispatches
asynchronously, so the boundary stops at the adapter.

That makes idle ticks and actions genuinely concurrent, so `idleFrames` — which
releases every button — stands off while an action holds the core. The guard
lives in the core rather than in the play host because every caller of the seam
needs it, not just the play path.

A live console also costs the play loop its cheapest "did anything happen?"
signal, and that has to be paid for rather than ignored. `observeEffect` diffs
the framebuffer digest to catch what the decoded state misses — a naming cursor,
a page swap — which only worked because a frozen console changed nothing except
what an action changed. Sampling that digest at observation time now spans the
whole decision, so ambient animation reads as the action's own effect: on
2026-08-15 a fruitless A press was reported to him as "screen changed … trust
the frame", and he spent the following turn discovering that it had not. The
digest is therefore sampled immediately before dispatch, narrowing the window
back to the action. Ambient change _during_ an action stays attributed to it,
which is the honest limit of a frame diff against a world that moves on its own.

Raw frames never enter semantic event streams. Evidence keeps carrying the
`framebufferSha256` digest it already carries, consistent with the media
boundary ADR 0024 sets for VUH-840.

The Clankie service and the activity server are separate processes, so the seam is a
concrete wire with a deliberate direction and exposure:

- The activity server runs **two listeners**. The viewer listener is tunnelled
  and public through the Discord proxy; the producer listener binds loopback
  only and is never tunnelled. A producer path mounted on the tunnelled server
  would be reachable by anyone who can reach the activity, so the split — not
  the bearer token — is the primary control. The token is the second lock.
- The **play host dials out** to the producer endpoint. The Clankie service holds
  credentials and opens no port for an internet-facing surface to connect into.
- The producer bearer lives in the **credential broker** under
  `clankie_activity_producer`, alongside the other internal Clankie bearers, and
  `CLANKIE_ACTIVITY_PRODUCER_TOKEN` is a hard startup error. The activity server
  owns the first-run mint because it owns the listener; the play host only
  resolves, so the two processes cannot mint divergent tokens.
- Ingress is deny-by-default: a play host with no resolvable credential publishes
  nothing rather than connecting unauthenticated.
- The wire is lossy in both directions by design. The play host drops frames while
  disconnected instead of buffering them, so a reconnect resumes at the present
  moment rather than replaying a stale playthrough; the hub drops frames for a
  backed-up viewer rather than growing a queue. Both count their drops.
- The latest frame and overlay are valid only while their producer is connected.
  Producer disconnect emits `stopped` and clears both values, so a late viewer
  never receives a finished playthrough labelled as live.

### Eligibility and constraints, stated plainly

- **Unverified activities run only in servers with fewer than 25 members, and
  only for the app team's developers and testers.** That covers the personal lab
  exactly. Verification is the documented path if this is ever made public, and
  is not in scope here.
- All activity network traffic is proxied through `discordsays.com`. URL
  Mappings must be registered in the developer portal, requests need a `/.proxy`
  prefix or `patchUrlMappings`, and unmapped external requests fail with
  `blocked:csp`. Local development needs an HTTPS tunnel.
- The activity is a distinct surface with its own risk: it renders Clankie's
  decoded internal state to every viewer. `activity_start` and `activity_stop`
  are therefore `publish-external`, matching `send_attachment` and `go_live_*`.
- Viewer input arriving from an activity is **ambient authority**. It cannot
  approve privileged actions, exactly as voice and text ingress cannot.

## Options weighed

- **Go Live via a selfbot user token as the primary path** — rejected as the
  default. It automates a normal user account against Discord's terms, risks the
  account, breaks whenever the custom UDP protocol changes, and would require
  weakening the `DISCORD_USER_TOKEN` hard-fail that is a startup
  error. It survives only as ADR 0024's separately gated lab capability.
- **Wait for Discord to allow bot video** — rejected. The request is open
  for years with no commitment.
- **Post periodic PNG attachments into the mission thread** — rejected as the
  primary path. It works and needs no new infrastructure, but it is not
  live, not in the voice channel, and cannot take viewer input. It remains a
  useful fallback when no activity is running.
- **Stream to Twitch/YouTube and link it in the channel** — rejected. It leaves
  Discord, adds a third-party account and its terms, and adds encode latency for
  a worse result than a canvas.

## Consequences

- A new `apps/discord-activity` workspace owns the iframe client and the frame
  server. It holds no Discord credentials and no mission authority; it is a
  rendering surface fed by the host.
- `apps/discord-bridge` gains activity launch and stop as policy-gated catalog
  actions on bot transport, under the existing deny-by-default guild/channel
  allowlists and content-free receipts. It gains no new credential class.
- `@clankie/protocol` and `@clankie/interactive-environment` gain the activity
  actions, their `publish-external` risk class, and the session facet. Action
  schemas stay transport-agnostic as ADR 0024 requires.
- The Clankie service owns the emulator body. `createRunnerGbaEnvironmentLifecycle`
  composes the `GbaEmulatorAdapter` behind the durable environment runtime, so
  playing is an agent decision dispatched through a lease rather than a script
  invocation, and the frame sink is an explicit option on that composition. The
  play host falls back to the clearly-labeled deterministic core double when no ROM
  is configured, so CI exercises the path without copyrighted bytes.
- Game audio remains absent: the core installs no-op `retro_set_audio_sample`
  callbacks and discards every sample. Narration covers the gap; mixing
  emulator audio into the existing 48 kHz stereo voice path is separate work.
- The `DISCORD_USER_TOKEN` startup error, ADR 0045's official-bot voice
  boundary, and the doctrine profile denials all stay exactly as they are.
