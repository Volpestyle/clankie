# Presence, desktop body and activity shares

What he is doing, his desktop expressions and pet face, and sharing live activity or artifacts.

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

## Activity artifact shares

Owners use `clankie share list` or `clankie share request JSON`; `/share` in
both consoles sends the same request. Local commands use the operator bearer;
hosted commands use the existing encrypted paired-device connection. Follow
[the request contract](../../../../docs/cli.md#activity-shares).

Start `sourceId:"play"` for Clankie's current authorized Pokémon/Minecraft
producer. An image uses exact delivered conversation/artifact IDs. Registered
`artifact:<conversationUUID>:<artifact48hex>` sources accept hash-checked PNG,
GIF animation or finite MP4 demo; never substitute a path, URL or new capture
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
