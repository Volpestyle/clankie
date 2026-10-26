# ADR 0295: A self-hosted bot admits its own Activity viewers

Status: accepted (VUH-2833, 2026-10-25). Extends ADR 0233.

VUH-2594 closed the anonymous legacy `/frames` stream to everything except
direct loopback. A self-hosted official bot's `/activity` launch reaches the
viewer from `discordsays.com` through the tunnel, with no fragment and no
credential, so it had nothing to admit it. Hosted bodies already admit through
the gateway; self-hosting needed its own server half of Discord's Activity
handshake.

The activity server stays a rendering client with no credentials. When an
Activity application id is configured, it answers `/.proxy/activity/config`
with `{mode:"official", applicationId, delegated:true}` for every request that
is not direct loopback, and relays `POST /.proxy/activity/admit {code,instanceId}`
over loopback to the service's `POST /v1/activity/admit`. That route accepts only
the broker-held activity producer bearer, which both processes already resolve.

The service performs the handshake:

1. It exchanges the code at Discord's OAuth2 token endpoint with the
   application's client secret, held only in the credential broker as
   `discord_activity_client_secret` and entered through `/discord` → Tokens. The
   token must carry `identify`; `/users/@me` names the viewer.
2. With the bot token it reads `GET /applications/{app}/activity-instances/{instanceId}`.
   The instance must belong to this application, and the viewer must be in its
   `users`. Its `location` alone, never an SDK guild or channel claim, selects
   the destination.
3. The destination must be a channel where Clankie's own bot posted the launch:
   a successful `activity_start` presence write records it, and `activity_stop`
   forgets it and stops its shares. A participant in an instance someone else
   started gets nothing.
4. It grants the channel's play share, opening one on first admission while play
   is running, and returns `{session,grant,expiresAt,mediaPath,accessToken}`.

Missing secrets fail closed with a 503 that names the console step. Every other
failure is a 403, and no path falls back to anonymous media.

Grants last at most five minutes. A self-hosted client renews before expiry by
authorizing again with `prompt: "none"` through the same SDK instance and
admitting again, then swaps sockets without clearing the picture. Each renewal
re-reads the instance.

## Known limit

A viewer who leaves the voice channel, or loses permission, keeps the current
grant until it lapses. Revocation is bounded at about five minutes, against
hosted's 15-second revalidation. [VUH-2834](https://linear.app/vuhlp/issue/VUH-2834)
tracks tightening it.

Room share tools still refuse with `activity_official_bot_required` for a
self-hosted bot: this ADR adds admission for the bot's own `/activity` launch,
not a launch/stop adapter for `ActivitySharing`
([VUH-2835](https://linear.app/vuhlp/issue/VUH-2835)).

A `#share` fragment still opens a delegated grant on a self-hosted viewer
outside Discord. Hosted config never sets `delegated`, so hosted viewers keep
their official-only behaviour.
