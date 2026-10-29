# Activity sharing

Clankie can share an existing game, delivered image, animation or finite demo
through a read-only Discord Activity. The Activity renders PNG and bounded PCM;
it has no authority to capture files, browse the machine, or control the source.

Use `clankie share list` and `clankie share request JSON`, or `/share` in either
console. The same `POST /v1/activity/shares` contract reaches the local service
with the operator bearer. `ClankieApiClient.activityShares(request)` exposes its typed
request and response schemas. [The CLI reference](cli.md#activity-shares) gives
complete examples.

| Source                            | Request selection                                                 | Boundary                                                               |
| --------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Current Pokémon or Minecraft play | `action:"start", sourceId:"play"`                                 | Existing authorized producer; no new player or capture grant           |
| Delivered PNG                     | `action:"image", conversationId, artifactId`                      | Exact delivered conversation/artifact and stored digest                |
| Delivered PNG/GIF/MP4/WAV/MP3     | `action:"start", sourceId:"artifact:CONVERSATION_ID:ARTIFACT_ID"` | Registered artifact ID; GIF/MP4/WAV/MP3 at most 32 MiB and 120 seconds |

`list` returns active session metadata. `switch` names the current share ID and
generation and chooses one registered source or exact conversation/artifact
pair. `stop` names the current share ID and generation. The service assigns the
tenant and current installation; a caller cannot pass a source URL, arbitrary
path or capture permission. Shares last 30 minutes by default, at most two hours.

Owner controls stream media without a launch adapter and make no claim that
Discord launched.

Discord room turns refuse `start`, `image` and `switch` with
`activity_official_bot_required` when no launch adapter is available. A
self-hosted official bot with Activity admission configured launches room shares
itself: `start` and `image` open the share in the voice channel the bot occupies
in that room's server (another channel is refused), then the room's own Discord
body posts the invite through its `watch_start` action, whose presence write
records the launch for admission. Its receipt is `confirmed`, `refused` (the
share is ended) or `uncertain` (the body may have acted; the share is kept and
nothing is resent). `stop` ends the share and revokes the invite through
`watch_stop`. Room share operations run one at a time across turns, so a stop
waits for a pending launch and no older launch can republish after it. A stop
also revokes every room launch reserved in that channel, so a body call that
outlived the tool's timeout is refused when its presence write finally arrives:
it posts no invite and registers no launch. A launch already inside its
Discord effect is checked again at each invite, delete and message step and
takes back anything that landed; a stop confirms only once that has finished,
and otherwise reports `uncertain`. Local
owner API/CLI requests can still create and switch delegated shares without an
adapter.

## Self-hosted official viewer

A self-hosted bot with an Activity application id and its OAuth2 client secret
admits voice-channel viewers of its own `/activity` launch
([ADR 0295](adr/0295-a-self-hosted-bot-admits-its-own-activity-viewers.md)).
Store the secret in the console at `/discord` → Tokens → Activity client secret;
it lives only in the credential broker as `discord_activity_client_secret`.
Without it, admission fails closed with a 503 naming that step.

The activity server relays the SDK's code and instance ID to the service. The
service exchanges the code, reads the Activity instance with the bot token, and
admits only a participant of an instance in a channel where Clankie's bot posted
the launch. The first admission while play is running opens that channel's play
share. Grants last five minutes; the viewer renews before expiry, and each
renewal re-reads the instance, so a viewer who leaves keeps media for at most
about five minutes ([VUH-2834](https://linear.app/vuhlp/issue/VUH-2834)).

## Local delegated viewer

Self-hosted local mode retains `/#share=SHARE_ID&grant=GRANT`. Read-only grants
remain in the fragment; never substitute an operator or producer bearer. This
is delegated access, not proof of Discord membership. Participant admission
for voice-channel viewers is the self-hosted official viewer above.

Grants last at most five minutes and terminate existing admitted viewers at
expiry. Source switch clears old image/text/audio, advances the generation and
invalidates old grants for new joins. Current viewers follow the switch until
their original grant expires. Stop, share expiry, producer loss and revocation
are terminal; reconnect cannot restore ended media or open a different share.
The scoped stream never feeds public legacy `/frames`.

## Local verification and remaining live gate

`pnpm --filter @clankie/discord-activity test:browser` builds the SDK bundle and
runs actual Chromium against loopback HTTP and WebSockets. It proves native PNG
decoding, Web Audio construction, two-tenant separation, source switch, terminal
stop/revocation, viewing beyond the initial admission deadline, configuration
failure and refused/anonymous admission. The
Discord RPC and admission provider boundaries use local fixtures; no Discord
account, tunnel or external media provider is contacted.

Official application registration and deployment remain prerequisites. Recorded
Discord iframe, launch, routing and playback checks remain pending; agents can
perform the technical verification once that setup is authorized and deployed.
Local browser evidence does not establish those live results. See the
[wire reference](../apps/discord-activity/README.md#scoped-general-media-core) and
[ADR 0233](adr/0233-activity-shares-own-their-media-scope.md).
