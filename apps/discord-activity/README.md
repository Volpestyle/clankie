# Discord activity surface

The activity plane's rendering surface ([ADR 0047](../../docs/adr/0047-discord-activity-presence-plane.md)).
The [Discord media guide](../../docs/discord-media.md) distinguishes this public
viewer from lab-user Go Live publishing and inbound screen-share watching.

Discord blocks video publication from bot accounts, so Go Live is unavailable to
an official bot and every library that implements it depends on a normal-user
selfbot token. Activities are the supported alternative: a web app hosted in an
iframe inside a voice channel, launched by the bot through an
`EMBEDDED_APPLICATION` invite. This app is that web app.

It is a **rendering client only**. It holds no Discord credentials, no
authority, and no emulator core. The host feeds it frames and bounded PCM; it
draws the frames and plays sound after the viewer presses **Enable sound**.
The button reads **Sound ready** until valid PCM actually reaches the browser;
**Sound on** means packets are arriving. The slider beside it sets playback
volume.
Its live lower third keeps Clankie's self-authored objective, intent, and
monologue separate from the observed effect; spoken output stays on the
voice surface rather than being duplicated here.

The same public listener serves host-baked agent persona avatars at
`/avatars/agent-<persona-uuid>-<png-sha256>.png` (and retains the version-1
SHA-256 persona form during migration). The app renders the exact
Garden `variant × accessory × shape` face, the captain validates and stores the
PNG under `~/.clankie/captain/persona-avatars/`, and this server returns it with
an immutable cache header. Discord webhook `avatar_url` requires this publicly
reachable HTTPS path; data URIs and local app assets are not fetchable by
Discord. The content hash changes the URL whenever the bytes change.

The older
[rendered-frame architecture JPG](../../docs/diagrams/discord-activity-architecture.jpg)
is a historical snapshot. Current game-body ownership is diagrammed in
[ADR 0129](../../docs/adr/0129-each-player-owns-a-body.md).

## Running it

```bash
CLANKIE_ACTIVITY_PORT=4320 \
CLANKIE_ACTIVITY_PRODUCER_PORT=4322 \
pnpm --filter @clankie/discord-activity start
```

Hosted-world frames use the world socket, while sound uses the host's read-only
watch listener. Local worlds started with `pokeagents start` bind that listener
at `127.0.0.1:7780` automatically. Custom or remotely published hosts must set
their private watch bind and public HTTPS origin explicitly; without a watch
listener the picture works while no PCM exists to play.

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

## The tunnel is a launcher-owned service

`clankie restart` starts and supervises the tunnel alongside everything else,
and `clankie health` probes it end to end. Configure it once in the operator
settings' `discord` block:

```jsonc
{
  "activityTunnelName": "clankie-activity", // cloudflared tunnel create <name>
  "activityTunnelHostname": "activity.clankie.bot", // the DNS route to it
}
```

Both unset means the launcher runs no tunnel and the activity stays local —
reported as healthy, because wanting it local is not a fault.

Settings alone are not enough. The launcher runs `cloudflared tunnel run <name>`,
which takes its ingress rules from `~/.cloudflared/config.yml` — the settings say
_which_ tunnel, that file says _where it points_. Create it alongside the tunnel:

```yaml
tunnel: clankie-activity
credentials-file: /Users/<you>/.cloudflared/<tunnel-uuid>.json

ingress:
  - hostname: activity.clankie.bot
    service: http://127.0.0.1:4320 # the viewer, never the producer
  - service: http_status:404
```

Publish only the viewer. The producer on 4322 must stay on loopback, for the
reason the two-listener table below spells out.

Full first-time setup, once the hostname's zone is on Cloudflare:

```bash
cloudflared tunnel login
cloudflared tunnel create clankie-activity
cloudflared tunnel route dns clankie-activity activity.clankie.bot
# write ~/.cloudflared/config.yml as above, set both settings, then:
clankie restart tunnel
```

In the Discord Developer Portal, map the Activity's root URL and Entry Point to
`https://activity.clankie.bot/`. The public hostname is also directly reachable;
Discord's `discordsays.com` proxy is not an authentication boundary. Keep the
producer listener absent from every URL mapping and tunnel rule.

The zone must be **active** in Cloudflare, not merely added. A pending zone
serves the routed hostname as a bare `*.cfargotunnel.com` CNAME that resolves to
nothing, because Cloudflare only proxies once it is authoritative — the probe
reports `unreachable` and the tunnel itself logs a clean connection, which reads
as a tunnel fault rather than an unfinished delegation.

**Use a named tunnel, not a quick one.** `cloudflared tunnel --url …` mints a
fresh `*.trycloudflare.com` hostname on every start, and the URL Mapping is
configured once in the developer portal — so a quick tunnel makes restarting the
thing that publishes him a breaking change. The predictable result: one gets
started by hand, never restarted, and outlives every deploy until its edge dies.
That is the 2026-08-01 failure, where a six-day-old quick tunnel had a live
process, a healthy server behind it, and a dead edge, and the activity rendered
blank in Discord with nothing reporting why
([ADR 0047](../../docs/adr/0047-discord-activity-presence-plane.md) owns the
plane; the incident is recorded in the launcher's tunnel service).

The probe asks the public hostname rather than the process table, because "a
`cloudflared` is running" is true for every one of those six days. It
distinguishes three states an operator repairs differently:

| Probe result           | Means                                         |
| ---------------------- | --------------------------------------------- |
| `healthy` + URL        | DNS, edge, tunnel, and origin all answered    |
| `edge up, origin down` | 5xx — the tunnel is fine, the activity is not |
| `unreachable`          | DNS or the edge is gone; restart the tunnel   |

## Two listeners, on purpose

| Listener | Bind      | Exposure                        | Purpose                                             |
| -------- | --------- | ------------------------------- | --------------------------------------------------- |
| Viewer   | tunnelled | public directly and via Discord | serves the client and `/.proxy/frames` media socket |
| Producer | 127.0.0.1 | loopback only, never tunnelled  | `/producer` media ingress                           |

The producer endpoint is a **separate listener**, not a path on the viewer
server. A producer path mounted on the tunnelled server would be reachable by
anyone who can reach the activity, so frame injection is kept off the public
surface entirely; the bearer token is the second lock rather than the only one.

**Only Clankie's active play path opens the producer connection.** The slot goes
to the newest connection and closes the previous one, and every sink reconnects
two seconds after being closed, so two connected producers would livelock. The
service therefore opens the sink only for its own active local or hosted play
session. GBA MCP has no producer dependency and returns frames only to its stdio
caller. Process ownership, rather than a shared body lock, keeps private harness
cores off this surface.

The activity server owns the listener, so it owns the first-run mint. The
clankie service only ever resolves, which avoids two processes minting
different tokens. A producer with no resolvable credential publishes nothing
rather than falling back to an unauthenticated connection.

The service dials **out** to this endpoint (`@clankie/rendered-surface-client`)
rather than accepting an inbound connection, so the trusted service opens no
port for an internet-facing surface to connect into.

## Bounds

- One encoded frame is capped at `RENDERED_SURFACE_FRAME_MAX_BYTES` (256 KiB);
  a real 240×160 GBA PNG lands in single-digit kilobytes.
- One stereo PCM packet is capped at `RENDERED_SURFACE_AUDIO_MAX_BYTES` (64
  KiB). Audio is never retained for a late viewer, and a slow socket drops it
  rather than letting sound lag behind play.
- The resident play host publishes at hardware rate (~60fps), deduplicates
  unchanged PNGs, and idles the core between turns, so the surface remains live
  rather than becoming a stale still.
- GBA MCP never publishes here. Its private core's optional PNG is returned only
  in the MCP observation result.
- A viewer whose socket backlog exceeds `maxBufferedBytes` has frames dropped
  rather than queued, and the drops are counted on `droppedFrameCount`. The
  standalone entrypoint reports that counter to stdout whenever it changes, so a
  stuttering stream names itself instead of being guessed at.
- The producer-side sink drops frames while disconnected rather than buffering
  them, so a reconnect resumes at the present moment instead of replaying a
  stale playthrough. Those drops are counted too. Work status is state rather
  than media, so the sink retains only its latest value and replays it on
  connect; the first long model decision is visible even when socket setup
  races the turn.
- The client's status line reads `<n> fps`, and names loss where it
  happened: `· <n> lost` counts gaps in the producer-assigned `sequence`, so it is
  everything lost before the canvas — producer socket, hub backpressure, Discord
  proxy. `· <n> slow` counts frames this browser abandoned mid-decode because a
  newer one landed first, which is the client failing to keep up rather than the
  network. A healthy stream shows neither.
- The thought header shows the current work state separately from transport
  health: `Waiting for session`, `Thinking`, or `Playing`. The producer emits
  thinking/acting at the real free-play boundary, the hub replays the latest
  state to late joiners, and an older producer falls back to `Live session`.
  Text carries the meaning; the three-dot motion honors reduced-motion.
- Producer messages are validated once at producer ingress before they reach
  the private hub or a viewer: frame and PCM sizes must agree with their
  payloads before they are forwarded.
- Lifecycle messages (`stopped`) are never dropped.
- Producer disconnect invalidates the latest frame, overlay, and work status,
  so an ended or crashed session cannot remain labelled live for late viewers.
- Concurrent viewers are bounded; an over-cap viewer is closed, not queued.

## What this app is not

- Not a recorder. Only the most recent frame, overlay, and work status are held;
  sound is not retained at all. Nothing is persisted, and media bytes never
  enter a semantic event stream — observations carry the framebuffer digest
  instead.
- Not an input or authority surface. The current viewer implements no keyboard,
  pointer, or outbound control channel.

## Eligibility

An **unverified** activity is launchable only by the app team's developers and
testers, and only in servers with fewer than 25 members — which is the personal
lab exactly. Verification is the documented path if the surface is ever made
public and is out of scope here.
