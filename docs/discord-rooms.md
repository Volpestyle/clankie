# Discord rooms behind the curtain

One Clankie has parallel room threads. `/conversation` reads the room's native
heard/said/tool history; it does not turn inspection into authority to send or
run tools there (ADRs [0124](adr/0124-one-self-has-many-local-threads.md),
[0176](adr/0176-every-room-is-an-inspectable-conversation.md), and
[0186](adr/0186-a-discord-room-harvests-its-own-workers.md)).

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
Managed hosts also return optional `managedPolicy` status: `synced`, `pending`,
`conflict`, `unavailable` or `disconnected`. A saved revision is distinct from
the revision acknowledged by the edge. Policy writes also compare a monotonic
sequence so an old write cannot succeed after a revision changes and reverts.
Conflicts reread the edge fence and retry
the body's current policy; the persisted settings are reconciled after restart.
`managedPolicy.revision` fingerprints the effective policy, including environment
overrides; `revision` on the settings snapshot still fences the stored owner edit.

The role-correct invitation requests Administrator for Admin and normal member
text/thread/voice permissions for Participant. Optional `setup.checks` reports
`passed`, `failed` or `not_checked` from the connected body's own guild and
self-member role evidence. Missing evidence is never success. Actual Participant
room access follows channel overwrites and Discord's platform permissions.
Opening setup, reading checks and saving controls do not post.

`fleetEnabled` and `trackingLevel` are independent. Participant fleet/tracking
messages use the designated `fleetChannelId`; Admin can create and place fleet
channels. Admin tracks each already bound project in the verified workspace as
a channel or forum, with one thread/post per issue. Levels are `off`,
`project_updates`, `project_activity` (status changes, milestones, new/finished
issues) and `all_issues`. Private event and destination mappings survive
turning tracking off. Unconfirmed mutations stay uncertain without automatic
replay. Disabling fleet display retains its selected server and room webhooks.

Settings are `serverId`, `role`, `fleetEnabled`, `fleetChannelId` and
`trackingLevel`. Legacy non-secret fields remain available under Advanced.
Connecting a server projects it into the body's ingress, presence and voice
server lists and clears channel filters, preserving machine grants and the
lab body's explicit opt-in. Environment overrides are reported by status.

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
its existing loopback control server using its brokered bridge bearer. The API
uses the authenticated managed provider instead on hosted bodies, scoped to
the customer's bound tenant/server and current installation. Changing `guildId`
cannot read another tenant's cache, and replacing the installation invalidates
the old body's reads. The hosted dashboard uses its narrow owner permit for the
same schema and pagination.
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
