# Discord bridge

Official Discord application/bot integration only. Do not automate a normal Discord user account or accept user-account credentials.

The bridge uses slash commands, optional bounded Discord text ingress, and explicit `/captain-join` / `/captain-leave` voice consent. Audio transcription, speaker memory, and retention are intentionally absent until their disclosure, consent, deletion, and visibility policies are implemented.

`/captain-mission` offers the three user ceremony presets: `rawdog`, `structured`, and `fine-control`. It defaults to `structured`; internal fixtures and doctrine overlays are not exposed as presets. The command creates exactly one Discord thread for the mission. A mode-0600 local state file binds the Discord interaction, guild, thread, and mission before retryable work crosses each boundary; thread names are presentation only and never restore authority. The bridge polls the authoritative mission snapshot, verifies its mission identity, and projects mission/task/approval-attention transitions into that thread. A persisted projection fingerprint prevents unchanged summaries from replaying after restart. `/captain-status` queries the current snapshot. `/captain-steer` targets its active worker run through an explicit finite choice list—focus, continue, retry, or summarize—and sends only the corresponding typed intent to the control plane. Discord never forwards arbitrary steering text.

Discord is an ambient authority surface. `DISCORD_AMBIENT_ROLE_IDS` is a comma-separated, deny-by-default role binding for mission creation and steering. `DISCORD_APPROVAL_ROLE_IDS` allows selected roles to receive an approval handoff, but `/captain-approval` always refuses to record the decision in Discord and links to `CLANKIE_AUTHENTICATED_SURFACE_URL`. The bridge never accepts or loads an operator approval token.

`/captain-memory` exposes the enforced bridge invariant: the bot does not persist channel transcripts, infer speaker memory, or retain slash-command text after forwarding it. Message-content access is requested only when bounded text ingress is explicitly enabled. The trigger and up to the configured number of preceding messages exist only in the Eve turn request and are excluded from ingress evidence. `forget` removes only the live bridge-owned thread/mission correlation and projection cache, renames and archives the thread so it is not rebound after restart, and explicitly does not claim to delete Discord history or authoritative control-plane/captain memory.

Required configuration. First store the bot token in the credential broker:
run `clankie`, then `/auth` → “Add / update API key” → “Other…” → provider id
`discord_bot`. The token is never read from an environment variable; both
`DISCORD_BOT_TOKEN` and `DISCORD_USER_TOKEN` are hard startup errors.

```bash
DISCORD_APPLICATION_ID=...
DISCORD_GUILD_ID=...          # optional, faster command registration in development
DISCORD_AMBIENT_ROLE_IDS=...  # comma-separated roles allowed to create/steer missions
DISCORD_APPROVAL_ROLE_IDS=... # comma-separated roles allowed to receive approval handoffs
CLANKIE_API_URL=http://127.0.0.1:4310
CLANKIE_CAPTAIN_TOKEN=...      # authenticated by the control plane as the Discord ambient captain lane
CLANKIE_AUTHENTICATED_SURFACE_URL=http://127.0.0.1:4311/approvals
DISCORD_MISSION_POLL_INTERVAL_MS=5000
DISCORD_BRIDGE_STATE_PATH=$HOME/.local/state/clankie/discord-bridge.json # optional absolute override

# Optional bounded text ingress (requires Message Content Intent in the Discord developer portal)
DISCORD_TEXT_INGRESS_ENABLED=true
DISCORD_INGRESS_GUILD_IDS=...        # deny-by-default guild allowlist
DISCORD_INGRESS_CHANNEL_IDS=...      # deny-by-default channel allowlist
DISCORD_INGRESS_DM_POLICY=owner_only # deny | owner_only | allowlist
DISCORD_OWNER_USER_ID=...            # required for owner_only DMs to be admitted
DISCORD_INGRESS_DM_USER_IDS=...      # used only by the allowlist DM policy
DISCORD_INGRESS_CONTEXT_MESSAGES=10  # transient preceding messages, 0-50
```

The bridge is a channel adapter. It never owns mission state, model credentials, approval credentials, or merge authority.

## Text ingress (ADR 0024 P2)

When `DISCORD_TEXT_INGRESS_ENABLED=true`, owner DMs and messages in the explicit guild/channel allowlists become bounded `DiscordPresenceChannelTurnRequest` values. Discord message IDs are the delivery idempotency keys. Bot/self messages, unallowlisted traffic, empty messages, and conflicting redeliveries stop before an Eve turn and emit content-free ingress evidence. Context history is fetched only after policy admission, capped at 50 messages, framed as untrusted turn-only input, and never written to bridge state or ingress logs.

The control plane authenticates the bridge as the `discord_text` captain source, addresses the `discord_presence` lane, and places trigger/context text only in Eve's ephemeral `clientContext`, which does not enter durable session history. The durable Eve message is a fixed content-free instruction, and the adapter retains no continuation cursor after the result. A settled response becomes a typed `discord.presence.reply` and passes through the existing narrative policy, rate ledger, credential broker, and bot REST runtime. A presence session is its own narrative attribution scope until a real mission is explicitly coupled; non-narrative actions still require mission attribution. Discord never records privileged approval.

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

## Presence actions (ADR 0024 P1)

Policy-gated bot presence actions (reply, react, send, …) execute through the control plane:

```bash
CLANKIE_DISCORD_PRESENCE_RUNTIME_MODULE=$PWD/apps/discord-bridge/src/presence-runtime-module.ts
DISCORD_PRESENCE_GUILD_IDS=...   # comma-separated broker grant allowlist
DISCORD_PRESENCE_CHANNEL_IDS=... # comma-separated broker grant allowlist
```

The module loads `discord_bot` only through the credential broker. Both
`DISCORD_BOT_TOKEN` and `DISCORD_USER_TOKEN` are hard startup errors; user-session
transport and Go Live are not accepted on this path.
See [`ADR 0024`](../../docs/adr/0024-discord-dual-plane-presence.md).

The bridge owns one official-bot presence session keyed by application id. Gateway readiness,
resume/reconnect/disconnect, invalidation, and the bot's own voice-state updates publish typed
phase transitions to the control plane over the authenticated captain channel. The control plane
projects that stream before exposing or executing presence actions; `degraded`, `failed`, and
`off` expose no act tools. Operator status therefore comes from semantic events rather than bot
log text, and an action payload can never manufacture the phase it requires.
