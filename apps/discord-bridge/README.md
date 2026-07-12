# Discord bridge

Official Discord application/bot integration only. Do not automate a normal Discord user account or accept user-account credentials.

The V1 bridge uses slash commands and explicit `/captain-join` / `/captain-leave` voice consent. Audio transcription, speaker memory, and retention are intentionally absent until their disclosure, consent, deletion, and visibility policies are implemented.

`/captain-mission` offers the three user ceremony presets: `rawdog`, `structured`, and `fine-control`. It defaults to `structured`; internal fixtures and doctrine overlays are not exposed as presets. The command creates exactly one Discord thread for the mission. A mode-0600 local state file binds the Discord interaction, guild, thread, and mission before retryable work crosses each boundary; thread names are presentation only and never restore authority. The bridge polls the authoritative mission snapshot, verifies its mission identity, and projects mission/task/approval-attention transitions into that thread. A persisted projection fingerprint prevents unchanged summaries from replaying after restart. `/captain-status` queries the current snapshot. `/captain-steer` targets its active worker run through an explicit finite choice list—focus, continue, retry, or summarize—and sends only the corresponding typed intent to the control plane. Discord never forwards arbitrary steering text.

Discord is an ambient authority surface. `DISCORD_AMBIENT_ROLE_IDS` is a comma-separated, deny-by-default role binding for mission creation and steering. `DISCORD_APPROVAL_ROLE_IDS` allows selected roles to receive an approval handoff, but `/captain-approval` always refuses to record the decision in Discord and links to `CLANKIE_AUTHENTICATED_SURFACE_URL`. The bridge never accepts or loads an operator approval token.

`/captain-memory` exposes the enforced bridge invariant: the bot does not request the Discord message-content intent, capture channel transcripts, infer speaker memory, or retain slash-command text after forwarding it. `forget` removes only the live bridge-owned thread/mission correlation and projection cache, renames and archives the thread so it is not rebound after restart, and explicitly does not claim to delete Discord history or authoritative control-plane/captain memory.

Required environment variables:

```bash
DISCORD_BOT_TOKEN=...
DISCORD_APPLICATION_ID=...
DISCORD_GUILD_ID=...          # optional, faster command registration in development
DISCORD_AMBIENT_ROLE_IDS=...  # comma-separated roles allowed to create/steer missions
DISCORD_APPROVAL_ROLE_IDS=... # comma-separated roles allowed to receive approval handoffs
CLANKIE_API_URL=http://127.0.0.1:4310
CLANKIE_CAPTAIN_TOKEN=...      # authenticated by the control plane as the Discord ambient captain lane
CLANKIE_AUTHENTICATED_SURFACE_URL=http://127.0.0.1:4311/approvals
DISCORD_MISSION_POLL_INTERVAL_MS=5000
DISCORD_BRIDGE_STATE_PATH=$HOME/.local/state/clankie/discord-bridge.json # optional absolute override
```

The bridge is a channel adapter. It never owns mission state, model credentials, approval credentials, or merge authority.

## ClankVox voice boundary

The reviewed schema-1 adapter contract lives in
[`src/clankvox-ipc.ts`](src/clankvox-ipc.ts), with golden wire examples under
[`test/fixtures/`](test/fixtures/). Node-to-Rust commands are capped NDJSON; Rust-to-Node events
use capped lane-plus-length frames with a dedicated binary per-speaker PCM lane.

The current `/captain-join` path remains a temporary consent path backed by `@discordjs/voice` and
does not capture or forward audio. VUH-806 replaces it for ClankVox sessions with direct
`guild.voiceAdapterCreator(callbacks)` registration and OP4 payloads sent through the returned
adapter. It must not call `joinVoiceChannel()` for the same session because that function creates
its own voice networking once the gateway packets arrive. See
[`ADR 0025`](../../docs/adr/0025-clankvox-placement-and-ipc.md).
