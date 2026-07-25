# Discord activity surface

The activity plane's rendering surface ([ADR 0047](../../docs/adr/0047-discord-activity-presence-plane.md)).

Discord blocks video publication from bot accounts, so Go Live is unavailable to
an official bot and every library that implements it depends on a normal-user
selfbot token. Activities are the supported alternative: a web app hosted in an
iframe inside a voice channel, launched by the bot through an
`EMBEDDED_APPLICATION` invite. This app is that web app.

It is a **rendering client only**. It holds no Discord credentials, no mission
authority, and no emulator core. The host feeds it frames; it draws them.

```mermaid
flowchart LR
  core["mGBA core (host)<br/>ROM never leaves"] --> stream["GbaFrameStream<br/>capped · deduped"]
  stream --> hub["RenderedSurfaceHub<br/>latest frame + overlay"]
  hub -->|"/.proxy/frames"| iframe["activity iframe<br/>canvas + overlay"]
```

## Running it

```bash
CLANKIE_ACTIVITY_PORT=4320 \
CLANKIE_ACTIVITY_PRODUCER_PORT=4321 \
pnpm --filter @clankie/discord-activity start
```

Only non-secret configuration is environment-supplied. The producer bearer is
minted into the credential broker on first start under provider id
`clankie_activity_producer`, exactly like the other internal Clankie bearers, so
it never reaches shell history, `ps` output, or a `.env` file.
`CLANKIE_ACTIVITY_PRODUCER_TOKEN` is a **hard startup error** — a process that
accepted both sources would silently prefer the weaker one.

Discord proxies all activity traffic through `discordsays.com`, so the server
answers both `/.proxy/*` and bare paths and local development needs an HTTPS
tunnel with a matching URL Mapping registered in the developer portal. A
relative request without the `/.proxy` prefix is refused as `blocked:csp`.

## Two listeners, on purpose

| Listener | Bind      | Exposure                       | Purpose                             |
| -------- | --------- | ------------------------------ | ----------------------------------- |
| Viewer   | tunnelled | public via the Discord proxy   | serves the client, `/.proxy/frames` |
| Producer | 127.0.0.1 | loopback only, never tunnelled | `/producer` frame ingress           |

The producer endpoint is a **separate listener**, not a path on the viewer
server. A producer path mounted on the tunnelled server would be reachable by
anyone who can reach the activity, so frame injection is kept off the public
surface entirely; the bearer token is the second lock rather than the only one.

The activity server owns the listener, so it owns the first-run mint. The runner
only ever resolves, which avoids two processes minting different tokens. A
runner with no resolvable credential publishes nothing rather than falling back
to an unauthenticated connection.

The runner dials **out** to this endpoint (`apps/runner/src/activity-frame-sink.ts`)
rather than accepting an inbound connection, so the trusted runner opens no port
for an internet-facing surface to connect into.

## Bounds

- One encoded frame is capped at `RENDERED_SURFACE_FRAME_MAX_BYTES` (256 KiB);
  a real 240×160 GBA PNG lands in single-digit kilobytes.
- The frame stream rate-limits to 20fps by default and drops frames whose bytes
  are unchanged, so an idle overworld costs nothing to publish.
- A viewer whose socket backlog exceeds `maxBufferedBytes` has frames dropped
  rather than queued. Drops are counted on `droppedFrameCount`, never silent.
- The runner-side sink drops frames while disconnected rather than buffering
  them, so a reconnect resumes at the present moment instead of replaying a
  stale playthrough. Those drops are counted too.
- Producer messages are validated before they reach a viewer: a frame whose
  `byteLength` disagrees with its payload is rejected, not forwarded.
- Lifecycle messages (`stopped`) are never dropped.
- Concurrent viewers are bounded; an over-cap viewer is closed, not queued.

## What this app is not

- Not a recorder. Only the most recent frame and overlay are held, nothing is
  persisted, and frame bytes never enter a semantic event stream — evidence
  keeps carrying the framebuffer digest instead.
- Not an authority surface. Viewer input arriving here is ambient authority and
  cannot approve privileged actions, exactly as voice and text ingress cannot.

## Eligibility

An **unverified** activity is launchable only by the app team's developers and
testers, and only in servers with fewer than 25 members — which is the personal
lab exactly. Verification is the documented path if the surface is ever made
public and is out of scope here.
