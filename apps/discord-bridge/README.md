# Discord bridge

Official Discord application/bot integration only. This process never accepts a
normal-user credential: both `DISCORD_BOT_TOKEN` and `DISCORD_USER_TOKEN` are
hard startup errors, and the bot token is read from the credential broker.

Clankie's separate personal-lab user-session body lives in
[`apps/discord-user-session`](../discord-user-session/README.md)
([ADR 0048](../../docs/adr/0048-discord-user-session-transport.md)); the two
processes never share a gateway or a credential. Both consume
[`@clankie/discord-presence-core`](../../packages/discord-presence-core/README.md)
for ingress shaping, the presence lifecycle, consent, capture, and lane
addressing, so this bridge holds only bot-shaped concerns: slash commands,
mission threads, the projector, and the activity plane.

The bridge uses slash commands, optional bounded Discord text ingress, and
explicit official-bot group voice. `/captain-join` discloses DAVE, brokered
OpenAI transcription, memory-only raw-audio handling, and AI-generated speech;
every other participant must opt in with `/captain-voice-consent`.

`/captain-mission` offers the three user ceremony presets: `rawdog`, `structured`, and `fine-control`. It defaults to `structured`; internal fixtures and doctrine overlays are not exposed as presets. The command creates exactly one Discord thread for the mission. A mode-0600 local state file binds the Discord interaction, guild, thread, and mission before retryable work crosses each boundary; thread names are presentation only and never restore authority. The bridge polls the authoritative mission snapshot, verifies its mission identity, and projects mission/task/approval-attention transitions into that thread. A persisted projection fingerprint prevents unchanged summaries from replaying after restart. `/captain-status` queries the current snapshot. `/captain-steer` targets its active worker run through an explicit finite choice list—focus, continue, retry, or summarize—and sends only the corresponding typed intent to the control plane. Discord never forwards arbitrary steering text.

Discord is an ambient authority surface. `DISCORD_AMBIENT_ROLE_IDS` is a comma-separated, deny-by-default role binding for mission creation and steering. `DISCORD_APPROVAL_ROLE_IDS` allows selected roles to receive an approval handoff, but `/captain-approval` always refuses to record the decision in Discord and links to `CLANKIE_AUTHENTICATED_SURFACE_URL`. The bridge never accepts or loads an operator approval token.

`/captain-memory` exposes the enforced bridge invariant: the bot does not persist channel transcripts, infer speaker memory, or retain slash-command text after forwarding it. Message-content access is requested only when bounded text ingress is explicitly enabled. The trigger and up to the configured number of preceding messages exist only in the Eve turn request and are excluded from ingress evidence. `forget` removes only the live bridge-owned thread/mission correlation and projection cache, renames and archives the thread so it is not rebound after restart, and explicitly does not claim to delete Discord history or authoritative control-plane/captain memory.

Required configuration. First store the bot token in the credential broker:
run `clankie`, then `/auth` → “Add / update API key” → “Other…” → provider id
`discord_bot`. The token is never read from an environment variable; both
`DISCORD_BOT_TOKEN` and `DISCORD_USER_TOKEN` are hard startup errors.

The non-secret settings below can be configured once from the TUI with
`/discord` instead of a `.env`; they are stored by `@clankie/settings` at
`~/.config/clankie/settings.json`. At startup the bridge fills only _unset_
names from that file, so an explicit shell value still wins, and it logs which
names it filled. Secrets never live there — the settings schema accepts
snowflakes, booleans, and enums only, and refuses token-shaped values at the
write boundary.

```bash
DISCORD_APPLICATION_ID=...
DISCORD_GUILD_ID=...          # optional, faster command registration in development
DISCORD_AMBIENT_ROLE_IDS=...  # comma-separated roles allowed to create/steer missions
DISCORD_APPROVAL_ROLE_IDS=... # comma-separated roles allowed to receive approval handoffs
CLANKIE_API_URL=http://127.0.0.1:4310
CLANKIE_AUTHENTICATED_SURFACE_URL=http://127.0.0.1:4311/approvals
DISCORD_MISSION_POLL_INTERVAL_MS=5000
DISCORD_BRIDGE_STATE_PATH=$HOME/.local/state/clankie/discord-bridge.json # optional absolute override
DISCORD_BRIDGE_RECEIPT_PATH=$HOME/.local/state/clankie/discord-live-receipts.jsonl # optional absolute override

# Optional bounded text ingress (requires Message Content Intent in the Discord developer portal)
DISCORD_TEXT_INGRESS_ENABLED=true
DISCORD_INGRESS_GUILD_IDS=...        # deny-by-default guild allowlist
DISCORD_INGRESS_CHANNEL_IDS=...      # deny-by-default channel allowlist
DISCORD_INGRESS_DM_POLICY=owner_only # deny | owner_only | allowlist
DISCORD_OWNER_USER_ID=...            # required for owner_only DMs to be admitted
DISCORD_INGRESS_DM_USER_IDS=...      # used only by the allowlist DM policy
DISCORD_INGRESS_CONTEXT_MESSAGES=10  # transient preceding messages, 0-50

# Optional official-bot group voice
DISCORD_VOICE_ENABLED=true
DISCORD_VOICE_GUILD_IDS=...          # deny-by-default guild allowlist
DISCORD_VOICE_CHANNEL_IDS=...        # optional; empty admits every voice channel in the allowlisted guilds
DISCORD_VOICE_CHANNEL_ID=...         # one private channel used by readiness/live proof
CLANKIE_VOICE_STT_MODEL=gpt-4o-mini-transcribe # optional
CLANKIE_VOICE_TTS_MODEL=gpt-4o-mini-tts        # optional
CLANKIE_VOICE_TTS_VOICE=marin                  # optional

# Optional activity plane (ADR 0047) — rendered surfaces in a voice channel
DISCORD_ACTIVITY_APPLICATION_ID_GBA=...        # embedded application id for the gba_emulator surface
```

## Activity plane

Discord blocks video publication from bot accounts, so the bot cannot Go Live.
The supported path is an **activity**: a web app in an iframe inside the voice
channel ([ADR 0047](../../docs/adr/0047-discord-activity-presence-plane.md),
served by [`apps/discord-activity`](../discord-activity/README.md)).

`discord.presence.activity_start` creates an `EMBEDDED_APPLICATION` invite for
the target voice channel and posts the launch link; `activity_stop` revokes the
channel's invites for surfaces this bridge configures. Both are
`publish-external` and run on the ordinary policy-gated presence path — no new
credential class, and `DISCORD_USER_TOKEN` remains a hard startup error.

Surfaces are deny-by-default: a surface with no configured application id cannot
be launched, so the plane stays off until an owner sets the variable above. A
model names a surface from the frozen catalog, never a Discord application id.

Stop is best-effort by design. Discord cannot evict viewers already inside a
running instance, so stop means "no further launches" — the frame stream going
dark is what actually ends the surface.

An **unverified** activity is launchable only by the app team's developers and
testers, and only in servers with fewer than 25 members.

Start the control plane once before the bridge. The control plane mints the
internal `clankie_discord_bridge` and `clankie_discord_voice_bridge` bearers in
the credential broker and authenticates them as the `discord_text` and
`discord_voice` captain lanes. The bridge resolves both directly from the
broker; `CLANKIE_CAPTAIN_TOKEN` is a hard startup error and no shared shell
secret is required. Voice reuses the brokered `openai` API credential;
`OPENAI_API_KEY` is a hard startup error when voice is enabled.

The bridge is a channel adapter. It never owns mission state, model credentials, approval credentials, or merge authority.

Run `pnpm discord:readiness` before starting the bridge. It verifies the two
broker entries, application identity, Message Content Intent, target-guild bot
membership, ingress/presence allowlist alignment, and the authenticated
control-plane composition. `--json` emits a content-free machine-readable
report suitable for an evidence artifact.

The bridge appends mode-0600 JSONL live receipts for gateway readiness, bounded
ingress outcomes, reply message ids, mission thread bindings/restoration,
ambient approval refusal, person-memory proposal/recall, and graceful stop.
Receipts contain bounded ids and typed outcomes only—never message bodies,
Discord names, or credentials.

After the live ceremony, run `pnpm discord:live-proof`. It requires an actual
admitted-and-settled text delivery with a reply id, a mission binding restored
across a graceful bridge restart, and an ambient approval refusal. Partial or
fixture-only receipts cannot pass this gate.

## Text ingress (ADR 0024 P2)

When `DISCORD_TEXT_INGRESS_ENABLED=true`, owner DMs and messages in the explicit guild/channel allowlists become bounded `DiscordPresenceChannelTurnRequest` values. Discord message IDs are the delivery idempotency keys. Bot/self messages, unallowlisted traffic, empty messages, and conflicting redeliveries stop before an Eve turn and emit content-free ingress evidence. Context history is fetched only after policy admission, capped at 50 messages, framed as untrusted turn-only input, and never written to bridge state or ingress logs.

The control plane authenticates the bridge as the `discord_text` captain source, addresses the `discord_presence` lane, and places trigger/context text only in Eve's ephemeral `clientContext`, which does not enter durable session history. The durable Eve message is a fixed content-free instruction, and the adapter retains no continuation cursor after the result. A settled response becomes a typed `discord.presence.reply` and passes through the existing narrative policy, rate ledger, credential broker, and bot REST runtime. A presence session is its own narrative attribution scope until a real mission is explicitly coupled; non-narrative actions still require mission attribution. Discord never records privileged approval.

`/captain-person-memory` proposes or recalls long-term person facts under the
stable guild/user identity. A proposal contains an explicit bounded fact, not a
transcript, and remains uncommitted until the authenticated operator surface
approves it. Ambient Discord cannot export or delete person memory. Recall
enforces guild/channel visibility and never returns operator-private facts.
Run `pnpm discord:person-memory-live-proof` after proposing a fact, approving it
on the authenticated operator surface, restarting the control plane, and
recalling that person from Discord. The gate requires the exact generated fact
id to be recalled from a different control-plane instance, proving both the
approval-only write path and durable restart behavior.

## Official-bot group voice

`@discordjs/voice` is the single media owner for the official bot
([ADR 0045](../../docs/adr/0045-official-bot-dave-group-voice.md)). Join fails
closed unless DAVE negotiates a positive protocol. The bridge subscribes only
to opted-in Discord user ids, caps each utterance at 30 seconds, sends a
memory-only WAV to brokered OpenAI transcription, addresses the continuing
`discord_voice` Eve lane, recalls only control-plane-approved person memory,
and converts memory-only OpenAI PCM speech back to Discord audio. Raw and
generated PCM buffers are zeroed after use.

Overlap is speaker-attributed, and a new speaker interrupts synthesis/playback
so stale responses do not talk over people. Voice receipts contain only ids,
counts, durations, DAVE version, and typed outcomes. Run
`pnpm discord:voice-readiness` before starting and
`pnpm discord:voice-live-proof` after a session with at least three consenting
human speakers. The live evaluator requires three complete captain/TTS round
trips, no failure receipt, and a clean leave.

The reviewed inactive ClankVox schema-1 compatibility parser remains in
[`src/clankvox-ipc.ts`](src/clankvox-ipc.ts); no AGPL ClankVox source is
imported or executed.

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
log text, and an action payload can never manufacture the phase it requires. Each authenticated
action carries the live session id, phase, and monotonic revision. The control plane requires that
claim to match its latest validated session record as well as the durable exposure. A loss-phase
callback synchronously advances the live revision and fences the advertised tool catalog before
durable publication can await I/O; bounded publication retries then reconcile the durable record.
After a control-plane restart, act execution remains fail-closed until an authenticated lifecycle
delivery revalidates the live watermark; durable session replay alone restores status only.
