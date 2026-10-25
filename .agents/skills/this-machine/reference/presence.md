# Presence, body leases and activity shares

What he is doing, his desktop expressions and pet face, who holds each body resource, and sharing live activity or artifacts.

## Presence and desktop body

`get_self_state` reports current activity; `clankie status` reports process
health. Source-derived presence and a desktop expression are separate: the
`desktop` tool can emote, move with normalized display coordinates or show a
short bubble. It publishes an expiring expression, not keyboard or mouse input.
Desktop clients honor quiet hours and macOS Focus; publication is not proof a
client displayed it. For app input, use `desktop-control` or a computer-use seat.

The `presence` read with `includeFace: true` also carries a source-derived `face` for the desktop
pet: working, new message, needs you, error or voice. Message and error faces
come from live committed owner-conversation events and expire; they do not
replay historical notifications. They leave the body animation and `desktop`
expressions separate. Reduce Motion keeps a static face. A published face
does not establish that the owner saw it.

## Voice provider readiness

Read `clankie doctor --json` → `voice.providerReadiness` before a call, or
`clankie discord call` → `providerReadiness` on the service. This opens only the
configured listener port: no audio, commit, response generation or Discord join.
The five-second probe shares a five-minute disk cache across CLI/service reads;
repeated doctor calls use it. `refused` with `credit_balance_exhausted` names
exhausted provider credit and outranks unrelated seat warnings. `missing_key`
requires a brokered API key; OAuth chat subscriptions do not qualify.
`unconfirmed`, `unavailable` and `checking` are not readiness. `ready` proves
listener admission only, not synthesis or a full call. Anthropic still needs
OpenAI transcription. Never infer that the whole voice stack works, change
accounts, top up credit, or join a room just from this read. No refresh switch
bypasses the cache.

## Body leases

`clankie body status` shows the stable conversation holding each of Discord
mouth, voice/Go Live, browser and play. Inspecting status grants no control.
Use the current conversation's `body_lease_request` tool to explicitly ask a
holder or queue a notification. Requests expire and never perform an effect
or transfer ownership. Recheck authority and reacquire when notified.
`clankie body request JSON` exposes the same operator API; see `docs/cli.md`
under the reported service root for its exact fields and recovery behavior.
Do not treat expiry or a process restart as proof that a send/session stopped.

A body lease marked `recovery_required` is still held. The service retries its
verified stop-check after a known service-owned holder's turn and body
operations end, at boot and with 5–60 second backoff. Missing or unreadable
holders and native-owned turns stay held for explicit owner recovery; display
activity is not native completion proof. Never infer release from expiry or a
failed close. A native seat holding an expired lease with no live operation is
woken once with the exact recover command; recover it promptly when finished,
because every other conversation, Discord rooms included, waits behind it. If it
persists, an authorized owner can inspect `clankie body status` and use
`clankie body request '{"action":"recover","resource":"browser","conversationId":"CONVERSATION_ID"}'`
from an existing writable conversation. Computer recovery uses its own contract.

## Owner-directed room posts

When the owner asks for a post in a Discord room, the operator seat calls
`room_turn` with either the room conversation ID or, for a channel with no room
conversation yet, its Discord `channel` ID. That channel must be a visible text
channel or thread in a server listed in `ingressGuildIds` (and in
`ingressChannelIds` when that list is set). The room is created the way ingress
creates it. `file` posts with the message, with or without `replyTo`. Its
`path` resolves against the operator conversation's working directory, which
is the service's working directory (the home folder by default), not the
caller's cwd or scratch folder. Copy the file inside that directory first.
Anything outside it fails with `delivered_file_outside_conversation_workspace`.
A room that only owners can read gets machine tools and private context. Any
other room gets a social one-shot that sees only the room and the brief
([ADR 0251](../../../../docs/adr/0251-discord-owners-and-room-skills.md#owner-directed-room-turns-2026-10-21)).

## Activity artifact shares

Owners use `clankie share list` or `clankie share request JSON`; `/share` in
both consoles sends the same request. Local commands use the operator bearer;
hosted commands use the existing encrypted paired-device connection. Follow
[the request contract](../../../../docs/cli.md#activity-shares).

Start `sourceId:"play"` for Clankie's current authorized Pokémon/Minecraft
producer. An image uses exact delivered conversation/artifact IDs. Registered
`artifact:<conversationId>:<artifact48hex>` sources accept hash-checked PNG,
GIF animation, finite MP4 demos and WAV/MP3 audio. Use the current conversation
ID, including native `room-…` IDs; never substitute a path, URL or new capture
grant. Switch selects one registered source or exact artifact pair. Use the
returned share ID and generation for switch/stop.

Preserve launch/stop receipts: confirmed, refused or uncertain, with request
identity and exact session. Never replay an uncertain control; read active
metadata and reconcile. Hosted viewers authenticate through the official SDK
and server-derived scoped admission, with continuing audience checks and no
anonymous fallback. Keep local read-only delegated grants in URL fragments;
they expire for admitted viewers and do not prove Discord membership.
Self-hosted delegated viewing does not automatically provide the official-app
launch/admission adapter. Hosted users never configure tunnels or applications.
Stop, expiry or producer loss clears media permanently.
