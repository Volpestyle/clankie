# Activity sharing

Clankie can share an existing game, delivered image, animation or finite demo
through a read-only Discord Activity. The Activity renders PNG and bounded PCM;
it has no authority to capture files, browse the machine, or control the source.

Use `clankie share list` and `clankie share request JSON`, or `/share` in either
console. The same `POST /v1/activity/shares` contract reaches the local service
with the operator bearer or the hosted service over the current encrypted paired
device connection. `ClankieApiClient.activityShares(request)` exposes its typed
request and response schemas. [The CLI reference](cli.md#activity-shares) gives
complete examples.

| Source                            | Request selection                                                   | Boundary                                                               |
| --------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Current Pokémon or Minecraft play | `action:"start", sourceId:"play"`                                   | Existing authorized producer; no new player or capture grant           |
| Delivered PNG                     | `action:"image", conversationId, artifactId`                        | Exact delivered conversation/artifact and stored digest                |
| Delivered PNG/GIF/MP4/WAV/MP3     | `action:"start", sourceId:"artifact:CONVERSATION_UUID:ARTIFACT_ID"` | Registered artifact ID; GIF/MP4/WAV/MP3 at most 32 MiB and 120 seconds |

`list` returns active session metadata. `switch` names the current share ID and
generation and chooses one registered source or exact conversation/artifact
pair. `stop` names the current share ID and generation. The service assigns the
tenant and current installation; a caller cannot pass a source URL, arbitrary
path or capture permission. Shares last 30 minutes by default, at most two hours.

Where an official launch/stop adapter is configured, controls return a receipt
with confirmed, refused or uncertain outcome, request identity and exact session.
A confirmed launch may include its Discord invite. Receipt uncertainty does not
authorize a retry: list active metadata and reconcile before deciding another
action. A local stream without the adapter makes no claim that Discord launched.

## Official hosted viewer

The locally bundled Embedded App SDK performs ready, authorize and authenticate.
The browser exchanges its code and instance ID through
`POST /.proxy/activity/admit`; the server determines the authenticated user's
current Activity, guild, channel, tenant and installation. The returned
read-only grant admits the media socket in its first message. The browser uses
neither SDK guild/channel claims nor fragments to select a hosted destination.
This follows [Discord's supported Activity handshake](https://github.com/discord/discord-api-docs/blob/main/developers/activities/building-an-activity.mdx).

The initial socket admission has a short, one-use deadline. Ongoing viewing is
bounded by the share's expiry, with audience authority revalidated at most every
15 seconds; the initial deadline does not end an already admitted viewer.
The gateway ends media on failed proof, revocation or installation replacement. Configuration,
authentication and admission errors open no media connection. Official mode has
no anonymous legacy fallback. The SDK uses only the viewer's ephemeral user
OAuth token; bot, client-secret and media-control credentials stay server-side.
Customers do not register an application, configure a tunnel or handle bot keys.

## Local delegated viewer

Self-hosted local mode retains `/#share=SHARE_ID&grant=GRANT`. Read-only grants
remain in the fragment; never substitute an operator or producer bearer. This
is delegated access, not proof of Discord membership. The local self-hosted
path does not automatically provide the official launch/participant adapter.

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

The live Discord iframe, official application configuration, distributed launch
qualification and human playback quality still require the owner's live check.
Local browser evidence does not establish those results. See the
[wire reference](../apps/discord-activity/README.md#scoped-general-media-core) and
[ADR 0233](adr/0233-activity-shares-own-their-media-scope.md).
