# Discord rooms behind the curtain

An owner may explicitly link a private text channel to the main Clankie
conversation with `clankie discord set --main-conversation-channel-ids CHANNEL_ID`
(comma-separated for several; `none` removes all links). The same field is in
the shared Discord settings API and the settings UI. This sends each admitted
message directly to the main conversation's existing runner, without a room
intermediary or child. A live native head receives a correlated escalation;
otherwise the normal service runner continues that same main conversation.
The room keeps an execution receipt naming `mainConversationId`.
Only the correlated answer returns to the original Discord message; ordinary
main-session output is never mirrored. Attachments arrive as untrusted Discord
references the head may inspect with its own tools; the room backlog is not
copied into the main context.

The sender must match the configured owner account, the server policy must be
`owners: me`, the transport must be the official bot, and the channel must pass
the existing owner-only audience proof and machine-access checks. Room-skill
channels cannot use this link. These checks run again before native admission,
before returning an answer and before replaying a saved private result. A shared
audience, removed binding or changed owner suspends the route. A definite native
refusal may select the normal service runner; an accepted or uncertain native
delivery never moves to another executor. Voice and unlinked rooms retain their
existing routes.

House-hunting feedback uses authenticated Discord IDs. An owner may explicitly
bind an exact legacy author label within one household through
`discord.houseHuntingAuthorBindings` in the shared settings API. Every entry
requires `ownerConfirmed: true`; names never prove identity. A binding alone
changes nothing. A later reconsideration by that ID appends explicit legacy
targets while preserving original authors and other people's rejections.
See [the CLI contract](cli.md#discord-status) and
[ADR 0252](adr/0252-household-legacy-authors-need-owner-confirmed-id-bindings.md).

One Clankie has parallel room threads. `/conversation` reads the room's native
heard/said/tool history; it does not turn inspection into authority to send or
run tools there (ADRs [0124](adr/0124-one-self-has-many-local-threads.md),
[0176](adr/0176-every-room-is-an-inspectable-conversation.md), and
[0186](adr/0186-a-discord-room-harvests-its-own-workers.md)).

Each voice `ask_clankie` handoff and admitted text request has its own thread
under Clankie in the dock and app. A text follow-up from the same person under
the same grant while their request is still running steers that request instead
(reported `absorbed`), so a burst gets one answer; other people keep their own
threads. The card shows who asked, the request, current
work and result; selecting it opens that request's transcript. Up to four
handoffs run globally, at most two per room. A 32-job waiting bound returns a
clear busy result when full. Finished jobs collapse so active work and seats
remain visible. Spoken answers retain the room's normal floor.
Replies return to the original asking room. Approval requests still continue on
the authenticated operator surface. With a Codex head, all non-owner room work
runs on Pi with the room's own tools, including explicit actor and server ownership grants. Mixed audiences and skill
rooms always use Pi; only owner-only rooms can use native children. See
[ADR 0229](adr/0229-room-handoffs-are-visible-parallel-threads.md) and the
[verification record](testing/2026-10-05-room-handoffs/README.md).

`clankie discord rooms` and TUI `/discord rooms` add delivery health. The API is
`GET /v1/discord/rooms`; its strict node-free contract lives in
`packages/protocol/src/discord-rooms.ts`. Counters describe observed outcomes in
the bounded retained delivery window (up to 4096 deliveries per room), not an
estimate of everything Discord might have sent while disconnected. A confirmed
Discord send counts as answered. Model completion does not. Buffered messages
remain pending; absorbed messages count as answered only when their linked send
is confirmed. Explicit backlog eviction counts as missed. No observations means
unknown, not zero evidence of failure. Silence reports `volitional_silence`, not
an invented explanation of the model's reasoning. Failures/escalations wake the
owner once per delivery through the existing content-free device push path.

Failed accepted text requests remain in the durable Discord inbox. On the next
healthy recovery round, Clankie checks for an existing bot reply before retrying
the saved request once. If that retry fails, the accepted message gets
one short failure notice asking the sender to resend. Legacy failures with no
saved request are reopened from the ingress receipts and get that notice without
rerunning tools from a possibly edited message. Neither a model result nor an attempted notice closes
the delivery; Discord confirmation does. A failed attempt waits before the next:
30 seconds, doubling to at most ten minutes, and a restarted bridge retries at
once. Only a permanent refusal ends recovery. The service refuses a reply
(`identity_required`) or its reconciliation
(`discord_reply_reconciliation_origin_required`) before touching Discord when it
holds no origin for that message, as for messages from before it kept delivery
origins. After three refusals the delivery closes as
`abandoned` with that code. Nothing is posted, so the asker never gets a late
answer or notice, and it is never retried (VUH-2394).

`unrecoveredFailed` counts failed messages still owed a confirmed reply or
notice, and `failed` reflects that current unresolved count. A recovery that
chose silence has answered. `abandoned` counts failures closed by a permanent
refusal, separately. Durable service turn and
confirmed reply receipts repair the projection after lost bridge observations;
a recovery reply clears pending and failed instead of leaving old failures displayed.
`clankie doctor` reports unresolved room deliveries as a next step and abandoned
ones beside them as a record.

The ingress receipts are the bridge's content-free journal,
`discord-live-receipts.jsonl`. Past 8 MiB it drops each repeated retry receipt
but the latest and keeps its newest 4 MiB, weeks of ordinary traffic. A rebuilt inbox seeds only from the last day of it.

A completed handoff's saved answer is replayed to its original room without
running its tools again. Before replaying an uncertain write, the authenticated
body reads that channel's reply history. A found reply settles the write; a
complete scan proving absence allows the existing body-lease recovery to release
an abandoned mouth. Failed or truncated reads preserve uncertainty and queue
the delivery. The native Discord nonce remains a second duplicate safeguard.
`POST /v1/discord/presence-actions?reconcile=1` performs only this read, under the
same current authenticated transport and live presence claim as writes. It
returns `{reply: result}` or `{reply: null}`; errors prove neither delivery nor
absence. A predecessor still running cannot have its write released this way.

Owner-directed `room_turn` names its room by conversation ID or by Discord
`channel` ID. A channel ID reaches a channel Clankie has not talked in yet, or
one with lane history but no conversation record. The service reads the channel
through the active body. It accepts a text, announcement or thread channel in a
server in `ingressGuildIds` (and in `ingressChannelIds` when that list is set),
then creates the room conversation the way ingress does. Other channels are
refused with `room_fork_channel_unavailable`, `room_fork_not_a_text_room` or
`room_fork_channel_not_admitted` before any turn runs. A proven owner-only
audience gets machine tools and private context. Any other room gets a social
one-shot with no machine tools and no private or fleet context beyond the
brief ([ADR 0251](adr/0251-discord-owners-and-room-skills.md#owner-directed-room-turns-2026-10-21)).
Participant servers keep every other limit: no server management and no posts
on a non-owner's request.

`file` posts with the message whether or not `replyTo` is set. Its `path` is
relative to, or absolute inside, the operator conversation's working directory.
That directory is the service's working directory (the home folder by
default), not the calling seat's cwd or scratch folder. A file outside it fails
with `delivered_file_outside_conversation_workspace`. Failures include their
concrete code in worker MCP output and the service log.

`clankie discord guide CONVERSATION_ID TEXT` or TUI `/discord guide` queues bounded
private context for that room's next naturally admitted turn. `--clear` clears it.
Nothing is posted as James and no new turn is started. Clankie decides how to use
it and whether to answer. Guidance never upgrades the room's tools or source
grants. Writes use `POST /v1/discord/room-guidance` with an expected revision.
The local operator or an active paired device with explicit `steer` may use this
dedicated route. This does not make the device an operator. Consumption rechecks
the original author and current source; restart expires guidance whose original
authority cannot be proven. The private pending text is visible only to authorized
observers, separate from public Discord messages.

`clankie discord call` and TUI `/discord call` show the current call, speech,
listening/thinking state, consented participant count and active captain handoffs.
Before anyone joins, `clankie doctor` checks the selected provider's listener
admission. `clankie discord call` and `/discord call` expose the same
`providerReadiness` through `GET /v1/discord/room-voice`. OpenAI (also Anthropic's
OpenAI transcription dependency) and xAI use their real listener port. The probe
sends no audio, commits no input and requests no generated response. It closes
on acceptance/refusal or after five seconds, with no meaningful usage spend.
A private disk cache under `CLANKIE_STATE/voice-provider-readiness` (default
`~/.clankie/voice-provider-readiness`) shares results across processes for five
minutes, including failures and in-flight reservations. A brokered API key or
listener-model change selects a new cache; unreadable cache storage never causes
an uncached provider request. There is no force-refresh switch.

`providerReadiness` reports `ready`, `refused` (for example
`credit_balance_exhausted`), `missing_key`, `unconfirmed`, `unavailable`, `checking`
or `disabled`, with check/expiry timestamps and whether the result was cached.
Only a normalized provider code is exposed; never the key or provider message.
When voice is enabled, a provider refusal takes doctor's headline ahead of
unrelated seat-bridge warnings. `ready` proves listener admission, not speech
output, conversation-model quota, or a successful end-to-end call. No synthesis
or paid response is attempted to establish those.

They also show the latest stay's `pipelines`: whether his hearing and answering are
`working`, `broken` or `unproven`, read from that stay's content-free receipts.
`broken` means the realtime provider's session was lost after that leg last worked:
no transcription from that speaker (hearing) or completed response (answering)
has arrived since. Hearing stays broken while any eligible speaker's listener is
lost; `pipelines.hearing.brokenUserIds` names the affected gateway user ids, also
shown by `/discord call` and doctor. A transcription from another speaker never
clears that loss. Consent withdrawal or departure retires that speaker's listener
from the report; a later opt-in starts unproven. Legacy loss receipts without a
`userId` stay unattributed and cannot be cleared by someone else's transcription.
A scheduled `lifetime` rotation reconnects on its own, so it counts as a loss but
never breaks a leg. The last loss carries its code, how the socket ended
(`closeReason`), the provider's close code and its last error code, never message
text. `clankie doctor` shows the latest stay on its card. Its next step names a
call that could not hear or answer, with the provider's error code, only while that
call is live or within an hour of its recorded end. A missing `endedAt` alone is
not proof of a live call: idle state suppresses that headline; unknown state
requires a loss within the last hour; an active replacement stay does not revive
old failures. Historical details remain on the card (VUH-2728, VUH-2765).
Join waits up to five seconds for the voice provider to confirm a listener session.
When it refuses (for example an account with no credit) or never answers, the join
fails as `provider_refused`, with the provider's code when it gave one, and no stay
begins. `joinRefusal` then shows the newest such
refusal since the latest stay, and doctor names it as the next step for an hour.
`clankie discord call join CONVERSATION_ID` joins an existing exact voice room only
when the configured owner is currently there. `leave`, `mute_output`, and
`unmute_output` require both conversation id and exact stay id. **Mute Clankie
speech output** interrupts and suppresses his speech, including queued speech;
it does not mute participants, change consent, pause music, or mute Go Live
publishing audio. Unmute never replays suppressed speech. These controls need
actual operator authority and preserve the original voice owner's authority and
lease incarnation. An unknown or replaced stay fails closed. Handoffs remain
model-owned actions, shown as observations rather than a new synthetic trigger.
Current speaker identities come only from consented active captures and the room
roster. Missing identity observations remain unknown; names are untrusted display
text. Mute suppresses immediately, but quiet remains unconfirmed until the exact
native playback reports stopped or drained. Lost confirmation keeps status unknown
and blocks unmute until exact native proof or the stay ends.

Exact voice words remain in the existing opt-in transcript path. Turning logging
off stops reads as well as retention. Room observation and transcripts require
operator or active paired `terminalObserve`; the existing captain transcript
consumer remains compatible. Paired requests keep their original device bearer
through the relay and recheck grants after awaited work.

`GET/POST /v1/discord/settings` reads or revision-fences the complete non-secret
Discord settings object. Writes require actual operator authority or the narrow
Discord-only hosted owner permit. The latter binds the exact encrypted request,
tenant, installation and current account connection grant; the body checks that
grant live before admission. Discord disconnect/reinstall revokes old permits,
without creating a paired device or general operator authority. The hosted
paired operator bridge still requires `mintedBy=hosted-account-operator` and
`terminalControl`; `steer` does not grant settings access. The canonical schema
lives in protocol and is reexported by settings. All canonical fields are editable under
TUI `/discord` → **Advanced** and existing `clankie discord set/clear`.
The optional `setup` member contains the shared server/role, fleet and tracking
controls from protocol's `discord-setup.ts`. The TUI, app and hosted dashboard
consume that definition; raw IDs remain under Advanced. Server selection uses
the connected account's directory. Participant has no setup channel list:
Discord permissions and overwrites decide which rooms Clankie can use.
Admin grants full control of a dedicated server, with server deletion and
ownership transfer refused at the adapter. Machine grants remain separate.
[ADR 0227](adr/0227-discord-connects-a-server-with-a-role.md) supersedes the
four-sentence setup.

The role-correct invitation requests Administrator for Admin and normal member
text/thread/voice permissions for Participant. Optional `setup.checks` reports
`passed`, `failed` or `not_checked` from the connected body's own guild and
self-member role evidence. Missing evidence is never success. Actual Participant
room access follows channel overwrites and Discord's platform permissions.
Opening setup, reading checks and saving controls do not post.

`discord.guilds[GUILD_ID]` holds each server’s role, owners, `fleetEnabled`,
`fleetChannelId` and `trackingLevel`. Fleet and tracking are independent per server. Participant fleet/tracking
messages use the designated `fleetChannelId`; Admin can create and place fleet
channels. Admin tracks each already bound project in the verified workspace as
a channel or forum, with one thread/post per issue. Levels are `off`,
`project_updates`, `project_activity` (status changes, milestones, new/finished
issues) and `all_issues`. Private event and destination mappings survive
turning tracking off. Unconfirmed mutations stay uncertain without automatic
replay. Disabling fleet display retains that server’s room webhooks.

Participant rooms always answer in a dedicated character session, created on
first admitted use and reused across speakers. Choose its harness once:

```sh
clankie discord server --server SERVER_ID --role participant --participant-harness claude
```

`discord.guilds[SERVER_ID].participantHarness` is `pi` by default; `claude`
starts the native interactive Claude Code TUI in Herdr. Its private character
directory and native history are separate from owner projects. The projected
plugin contains public persona, the room channel and transcript synchronization. It has
no owner memory hooks, fleet skills, inherited MCP servers or account tools;
the channel exposes only `reply` for the original room message. Commands,
file changes, network research and skills require the owner's native permission
prompt. Discord administrator roles, Everyone ownership and individual machine
grants cannot raise a participant session's authority. Even an owner message
keeps the room's public context and this permission boundary.

The native launch journal survives service restarts. Concurrent messages reuse
one launch; a lost launch response requires reconciling the original pane.
There is no automatic redispatch through Pi or the owner's session. A changed
native occupant or configuration withholds the reply. Up to four live native
characters may be allocated; close an unused character in Herdr to make room.
A native startup/trust prompt may need the owner before the channel connects.
The service never answers that prompt from Discord text. Pi participant loops
start automatically too and retain existing explicitly granted room-skill
adapters; native Claude characters currently expose only their reply channel.

### Recovering an uncertain character launch

The private journal is `<stateDir>/participant-room-launches.json`, normally
`~/.clankie/captain/participant-room-launches.json`; `CLANKIE_STATE` changes the
body state root, with `captain` below it. `starting` or `uncertain` without a
reconciled pane blocks a second launch. A malformed journal blocks every native
participant launch while leaving other service work available.

First inspect the complete Herdr inventory (`herdr agent list` and
`herdr pane process-info --pane ID`) for the character's working directory,
`<stateDir>/participant-rooms/room-HASH`, and its recorded native session.
If the original exists, reconnect that pane; the next message reconciles and
reuses it. An unreachable inventory or unresolved process is uncertainty, so
keep the entry. Never clear it just because a timeout expired.

After the owner confirms that the original process and launcher are gone,
stop Clankie with `clankie stop clankie` and keep it stopped during the repair.
Back up the journal, then remove only that exact room's entry. For example,
replace `room-HASH` with its full canonical ID:

```sh
participant_state="${CLANKIE_STATE:-$HOME/.clankie}/captain"
python3 - "$participant_state/participant-room-launches.json" room-HASH <<'PYREPAIR'
import json, os, pathlib, re, shutil, sys, time
path, room = pathlib.Path(sys.argv[1]), sys.argv[2]
assert re.fullmatch(r"room-[a-f0-9]{24}", room)
entries = json.loads(path.read_text())
assert entries[room]["phase"] in ("starting", "uncertain")
shutil.copy2(path, path.with_name(path.name + f".backup-{time.time_ns()}"))
del entries[room]
temporary = path.with_name(path.name + ".owner-repair")
with temporary.open("x") as stream:
    os.chmod(temporary, 0o600)
    stream.write(json.dumps(entries))
os.replace(temporary, path)
PYREPAIR
clankie start clankie
```

The next admitted message creates one session; later messages reuse it. Failed
message receipts remain failed and are not automatically replayed. This repair
does not erase character files, native history or delivery receipts.

For corrupt JSON, retain the damaged file and restore a known-valid backup
while the service is stopped. If there is no usable backup, inspect every
character directory against a complete native inventory first. Only after
confirming all those launchers and sessions are gone, move the damaged journal
aside and replace it with an owner-readable `0600` file containing `{}`. Restart
Clankie; persisted native history is resumed by the normal admission checks.

Each server has a role (`participant` or `admin`) and owners: Just me (`me`,
the configured `ownerUserId`), Everyone (`everyone`), or a Discord role (`role`
with `ownerRoleId`). `discord.guilds` records these choices. Admin manages the
server but gives its members no machine authority. `discord.servers` and the
single selected fields remain compatibility projections for older clients.
Migrating a single choice retains its projection options; other policies start
with fleet and tracking off. Tracking deliveries are journaled per guild.

`discord.roomSkills` adds one named skill to a room. The initial `house-hunting`
adapter reads and maintains that room's household criteria and listing ledger,
using the installed skill's listing API and social browser. It accepts structured
operations, never a command, executable, arbitrary path or credential. Households
are isolated per room; only the recorded legacy migration retains the existing
household. A skill room has no shell, fleet tools or owner work context.

The CLI writes the same revision-fenced `GET`/`POST /v1/discord/settings` API:

```sh
clankie discord server --server SERVER_ID --owners me --role participant --fleet off
clankie discord owners --server SERVER_ID --owners role --owner-role ROLE_ID
clankie discord room-skill --server SERVER_ID --channel CHANNEL_ID --skill house-hunting
clankie discord room-skill --server SERVER_ID --channel CHANNEL_ID --skill off
```

TUI `/discord` offers **Server owners and options** and **This room can use**, using names
from the connected account. Raw policy JSON and IDs stay under Advanced. App
and hosted dashboard ownership/skill pickers are follow-ups in their respective
repositories; their existing setup controls retain the new fields when saving.

For Admin servers and owner DMs, ownership is resolved on each delivery. Discord role membership comes from the
credential-owning body, never from message text. An owner in a mixed room keeps
one-shot machine tools, but the context withholds private work and fleet detail,
including when an owner asks. Non-owners get social tools and exactly the room's
skill adapter. Mixed-room machine turns use fresh Pi sessions with bounded
room history. Participant Pi rooms reuse a loop under the same skill grant. Revocation rechecks settings at tool execution.

Owner outreach, room relays, tracking messages and fleet webhooks require an
owner-only audience. Everyone-owned servers satisfy that ownership condition;
private rooms otherwise need live channel overwrites, guild-owner and role
permission evidence. Administrator bypasses overwrites, so a non-owner admin
role makes the audience unsafe. Missing evidence refuses delivery with
`discord_owner_audience_required`. Being an Admin server alone is insufficient.

Household feedback records the authenticated Discord speaker ID. Old
name-attributed rejections stay readable and excluded; explicit owner-confirmed
legacy bindings are tracked in [VUH-1834](https://linear.app/vuhlp/issue/VUH-1834).
Display names are never proof of authorship.

Legacy `systemActorGuildIds` and `systemActorChannelIds`, including environment
overrides, no longer grant machine authority. Existing settings normalize on
load and persist on the next normal write. Only the recorded house-hunting room
migrates to its named skill; other old room grants fail closed. Explicit individual
`systemActorUserIds` remain compatibility grants. See
[ADR 0251](adr/0251-discord-owners-and-room-skills.md).

`POST /v1/discord/setup/test-post` remains an explicit owner diagnostic using
`guildId`, `channelId` and `expectedRevision`. It requires settings-level
operator authority and rechecks configuration, connected account and permission
before dispatch. The fixed message disables mentions. A receipt returns
`posted` and a message ID; missing receipts return `unconfirmed` and are never
automatically retried. The CLI is `clankie discord setup test-post --channel
general`. This diagnostic is outside normal setup.

Credentials remain in the credential broker. Environment overrides and settings
that require a body restart retain their existing behavior; changing a stored
field does not claim the running body already applied it.

The official bot supports both roles. The advanced personal-lab user body keeps
its recorded channel consent. Its current opt-in cannot express full-server
Admin consent, so server management is refused there. Participant projection
posts also need the designated channel inside that existing consent. Selecting
Admin does not widen a lab account's recorded scope.

Body evidence uses an authenticated current Discord body session, exact transport
and current room allowlists. It cannot grant tools or reconstruct a source owner.
Voice health uses accepted input, explicit floor silence/failure, and actual audible
playback completion in the same live stay. Provider completion and suppressed
output never count as an answered room turn. Unattributed/ambient outputs and
unobservable outcomes remain unknown; there is no inferred voice missed counter.
Voice control nonces and lease references are host-only and never returned by
room snapshots. No endpoint acquires a second body or bypasses recovery.

## Discord directory for settings pickers

`GET /v1/discord/directory?kind=servers` lists servers the connected account
can see. `kind=channels|roles|people` requires `guildId`. Entries carry their
IDs, display names and kinds; `limit` defaults to 100 (maximum 200), and
`nextCursor` becomes the next request's `after`. Sort order is Discord ID order,
so rename/reordering does not move a cursor. Results describe a live cache;
refreshing is appropriate after membership or permissions change.

`clankie discord directory` and `clankie discord directory channels --server ID`
read the same authenticated API. Use `roles` or `people` for those pickers.
The active official-bot or user-session body supplies its own gateway view over
its existing loopback control server using its brokered bridge bearer.
The ordinary paired API reuses room Observe authorization, retains the original paired bearer through
the relay, and rechecks authority and active body before returning data.

`state` distinguishes `connected`, `disconnected`, `partial`, and `unavailable`;
`reason` explains an incomplete or unavailable read. An empty connected server
list means the account is in no known servers. A disconnected or failed read
never masquerades as that result. Cached people are explicitly partial: no new
privileged member intent or member enumeration is requested. Channels are
partial because archived threads are not enumerated; the user-session cache
also omits threads rather than guessing membership. Missing permission evidence
omits the affected channel and reports `permissions_unknown`.

Bot channels use discord.js permission calculation plus private-thread
membership. User-session channels use the account's delivered roles, own
membership and [Discord’s documented overwrite order](https://docs.discord.com/developers/topics/permissions#permission-overwrites), with BigInt permission
flags. Hidden channel IDs and names are omitted. The directory never falls back
to the other account, reads stored Discord credentials, posts a message, joins a
server, or grants computer access. Names remain untrusted display text.
