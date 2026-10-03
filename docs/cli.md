# CLI

This is the command contract for agents, scripts, and people using Clankie from
a terminal. For installation, use [Get started](https://docs.clankie.bot/get-started/).
For console keys and slash commands, use the [console reference](https://docs.clankie.bot/console/).

`clankie <noun> <verb>` exposes headless configuration and control. The CLI and
local TUI share command functions and configuration writers; the TUI adds
interactive forms and navigation
([ADR 0012](adr/0012-provider-auth-model-registry.md)).

Live operator work stays on the service HTTP catalog already shared by the TUI,
phone and relay: chat, play, memory, pairing, and conversations are
not separate copies of the service's state. The commands below describe local
mode unless noted. [Hosted mode](#local-and-hosted-connection-modes) connects to
an existing remote service with a smaller supported set.

`clankie help` prints the same command index. On every install the file lives
at `{repoRoot}/docs/cli.md` — `clankie doctor` names `repoRoot`.

## Invocation

```bash
clankie                         # choose mode on first run; open the selected console (TTY)
clankie --version               # also -V
clankie --chat <conversationId> # resume a server-owned operator conversation
clankie <command>               # headless; no TTY
clankie help                    # also --help, -h
```

`--chat` is stripped before headless routing. In local mode, with no command,
the launcher starts the service if needed and opens the existing main **Clankie**
conversation, regardless of the launch directory. It does not create a chat.
Use `--chat ID` for another retained conversation, `/new` for a fresh chat,
or `/cd PATH` to select a project conversation.
An unknown command exits 1 without starting anything. Common near-misses name
the real command: stop the service with `clankie down`, not `stop`.

## Conventions

| Rule                            | What it means                                                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| One JSON document on stdout     | Agents parse stdout. Progress and human narration go to stderr.                                                                        |
| Exit 0 or 1                     | 0 is success. 1 is failure. `doctor` always exits 0 — `ok` means the card was produced.                                                |
| Secrets never as flags          | No API keys, Discord tokens, or operator bearers on the command line. `/auth` and `/discord` in the console, or the credential broker. |
| Fail closed, secret-free errors | Failure messages never echo tokens, pairing codes, or response bodies.                                                                 |
| Host                            | `CLANKIE_CONTROL_PLANE_URL` (default `http://127.0.0.1:4310`). `CLANKIE_CAPTAIN_URL` is a compatibility alias.                         |

`--json` is required only where the default is human-readable (pairing QR,
device and machine tables, credential-rotate sentence). Everything else is already JSON.
`rivals connect --token-stdin` reads its bridge token from a pipe into the broker;
the token is never an argument, settings value, or printed result.

| Command                                                                                                                       | stdout                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `health`, `status`, `doctor`, `restart`, `down`, `autostart …`, `awake`                                                       | JSON                                                                                         |
| `model …`, `effort …`, `image-model …`, `video-model …`                                                                       | JSON                                                                                         |
| `linear …`, `persona …`, `games …`, `browser …`, `fleet …`, `herdr use/create/disable`, `workdir …`, `discord …`, `gateway …` | JSON (`herdr open` opens the terminal viewer)                                                |
| `play status`                                                                                                                 | JSON                                                                                         |
| `send --conversation ID …`                                                                                                    | JSON accepted-run receipt or refusal                                                         |
| `file publish --conversation ID PATH …`                                                                                       | JSON delivered-file metadata                                                                 |
| `memory …`, `metrics …`                                                                                                       | JSON                                                                                         |
| `telemetry ship …`                                                                                                            | One JSON line per shipping pass                                                              |
| `play stop`                                                                                                                   | JSON when a session is stopping; the sentence `Nothing is playing.` when idle (still exit 0) |
| `prompt …`, `memory-card …`                                                                                                   | Plain text: the prompt or card itself, verbatim                                              |
| `seat`                                                                                                                        | Interactive (TTY); `seat --dry-run` is JSON                                                  |
| `mcp`                                                                                                                         | JSON-RPC for a harness, never for people                                                     |
| `pair`, `devices`, `machines`, `herdr status`, `operator-credential rotate`                                                   | Human text; pass `--json`                                                                    |
| `help`                                                                                                                        | This index (plain text)                                                                      |
| `--version`                                                                                                                   | `clankie <version>`                                                                          |

Do not edit `~/.config/clankie/clankie.json`,
`~/.config/clankie/settings.json`, or Keychain entries by hand.

## Command index

| Task                                                   | Commands                                                |
| ------------------------------------------------------ | ------------------------------------------------------- |
| [Diagnose the installation](#diagnostics)              | `health`, `status`, `doctor`                            |
| [Manage service lifecycle](#service-lifecycle)         | `restart`, `down`, `autostart`, `awake`                 |
| [Pair and manage devices](#device-setup)               | `pair`, `devices`, `gateway`                            |
| [Connect accounts and track work](#account-setup)      | `accounts`, `work`                                      |
| [Choose working skills](#skill-setup)                  | `skills`                                                |
| [Choose models](#model-setup)                          | `model`, `effort`, `image-model`, `video-model`         |
| [Connect machines](#runtime-setup)                     | `machines`, `connections`, `runtime`, `agents`, `herdr` |
| [Read and send conversations](#conversation-commands)  | `conversations`, `send`, `file`, `memory`               |
| [Use native seats and delegated tools](#seat-commands) | `seat`, `mcp`, `access`                                 |
| [Evaluate agent work](#evaluation-commands)            | `evaluator`                                             |

## Commands

<a id="diagnostics"></a>

### `health` / `status`

Probe every launcher-owned service and the operator credential. `health` and
`status` are the same verb.

```json
{
  "ok": true,
  "status": "ready",
  "host": "http://127.0.0.1:4310",
  "owned": false,
  "pid": 12345,
  "operatorCredential": { "present": true, "source": "store", "consistency": "store_only" },
  "services": [{ "id": "clankie", "state": "healthy", "owned": true }]
}
```

`ok` is true only when the clankie service is healthy **and** the operator
credential is present without an env/store mismatch. Exit 1 otherwise.
`status` is `ready`, a service state (`unreachable`, `unhealthy`), or
`operator_credential_<consistency>`. Top-level `owned` and `pid` appear when
the clankie row has them. The payload never includes fingerprints or secret
values.

Service ids appear in dependency order: `clankie`, `relay`, `discord-bridge`,
`discord-user-session`, `activity`, `tunnel`, `awake`. `awake` is the owner's
keep-awake ([`awake`](#awake)); it reads healthy and "off" until
they opt in.

### `doctor`

The install card ([ADR 0142](adr/0142-the-install-tells-him-the-truth.md)).
Always JSON, always exit 0. `ok` means the card was produced. Missing optional
tools are facts in `remediations`, not failures.

```json
{
  "ok": true,
  "kind": "checkout",
  "version": "0.2.0",
  "repoRoot": "/path/to/this/install",
  "model": "xai/grok-4.6",
  "captain": { "ready": true, "model": "xai/grok-4.6", "providerId": "xai", "auth": "credential" },
  "imageModel": null,
  "videoModel": null,
  "persona": { "displayName": "Clankie" },
  "discord": {
    "activeBody": "bot",
    "textIngressEnabled": true,
    "voiceEnabled": true,
    "userSessionEnabled": false,
    "machineGrantUsers": 0,
    "machineGrantGuilds": 0
  },
  "voice": { "realtimeProvider": "openai", "ttsProvider": "openai" },
  "gameplay": { "pokeagentMmoEnabled": false },
  "emailConfigured": false,
  "mcpServers": [],
  "credentials": [{ "id": "openai", "type": "api" }],
  "commands": { "herdr": { "present": false } },
  "herdrPlugin": { "bundled": true, "bundlePath": "…/integrations/herdr-plugin" },
  "laneTools": { "url": "http://127.0.0.1:4310/v1/mcp", "reachable": true },
  "doorway": { "state": "connected" },
  "power": {
    "state": "sleep_allowed",
    "source": "battery",
    "sleepAfterMinutes": 1,
    "heldAwakeBy": [],
    "keepAwakeRequested": false,
    "advice": "On battery this Mac sleeps after 1 min idle, so Discord and the app go quiet. Plug in and run `clankie awake on` to keep it awake while plugged in, or use a hosted Clankie."
  },
  "remediations": ["Pick a captain model with `clankie model set provider/model` or `/setup`."]
}
```

`kind` is `checkout` or `release`. `captain` says whether Clankie can take a
turn at all ([ADR 0190](adr/0190-setup-asks-one-question-then-clankie-takes-over.md)):
`{ "ready": true, "model", "providerId", "auth" }` with `auth` one of
`credential`, `env`, `endpoint` or `subscription`, or `{ "ready": false,
"reason": "no_model" | "no_credential" }`, naming the model and provider when
one is chosen. A chosen model with nothing to sign it in earns a remediation.
Credential entries are ids and types, never secrets. `commands` currently
probes `herdr`, `ffmpeg`, `yt-dlp` (version strings) and `herdr-lead`, `codex`,
`claude` (PATH only — never execute `herdr-lead --version`).
`laneTools` names the streamable-HTTP MCP route that serves a lane's tool bank
([ADR 0152](adr/0152-a-harness-takes-the-operator-seat.md)); `reachable` is
true when it answers an unauthenticated probe with 401, so the route is served
and wants a lane bearer. `doorway` is the live public doorway
([ADR 0151](adr/0151-the-public-doorway-routes-home.md)) in the states
`clankie gateway status` reports; `sign_in_required` and `unavailable` each earn
a remediation, because until they clear no app reaches him at all.
`power` says whether this Mac may sleep, which drops Discord and the app while
it is down ([always-on guide](always-on.md)). `state` is `always_on` (power
settings never sleep, or something holds a sleep assertion), `sleep_allowed`
(with `advice`, which is also a remediation), or `unknown` (no `pmset`, as on a
hosted Linux body; no warning). `source` is `ac` or `battery`,
`sleepAfterMinutes` is the `pmset` idle sleep for that source (`0` never), and
`heldAwakeBy` names processes holding a sleep assertion that applies on that
source. `lastSleep` appears once the running service has noticed the host sleep
underneath it. The same object is on the service's `/health` as `power`.

<a id="service-lifecycle"></a>

### `restart [service]`

Restart launcher-owned services in dependency order
([ADR 0055](adr/0055-launcher-owned-local-services.md)). Default target is
`all`. Progress lines go to stderr; stdout is JSON:

```json
{
  "ok": true,
  "status": "ready",
  "target": "clankie",
  "host": "http://127.0.0.1:4310",
  "owned": true,
  "services": [{ "id": "clankie", "ok": true }]
}
```

Naming a service restarts it **and** anything that holds a live claim against
it. `clankie` (`captain`) also restarts `relay` and the Discord body, because
those processes cache presence and bearer state from this service instance.
Stopping is different: `down` names one service and stops only that service.

Local HTTP services check listeners on their configured port (`PORT` for
Clankie, `CLANKIE_RELAY_PORT` for the relay, and both `CLANKIE_ACTIVITY_PORT`
and `CLANKIE_ACTIVITY_PRODUCER_PORT` for the activity). A scratch instance on
other ports does not block them. This uses
`lsof`, supplied by macOS and required in Linux installations for this check;
if inspection fails, the launcher conservatively refuses matching unowned
processes. Named activity tunnels check their configured tunnel name. Foreign
processes are never signalled.

Use plain `clankie restart` for a normal restart. The optional service target
is only needed to select a narrower dependency set.

Clankie can run this from his own bash in the console or an authorized Discord
text/voice turn. The launcher detaches a helper and waits for the current turn
to settle. Stdout reports `"status": "scheduled"` with `afterRun` (console) or
`afterSession` (native Pi room), plus `logPath` for the helper's output. This is
success (exit 0), not proof of recovery: finish the reply, then check the log
and `clankie status`, including the Discord bridge. The helper cancels if the
turn has not settled within ten minutes. No hired worker or custom sleep script
is needed; a hired worker's backend may share the service's process lifetime.

New service processes clear inherited pnpm lifecycle and Pi session markers.
Otherwise a restart launched from a running package script can be mistaken for
a recursive `start` and skipped by pnpm, leaving all stopped dependents offline.

### `down [service]`

Stop in reverse dependency order. Default `all`. Same stdout shape as restart,
with `"status": "stopped"` on success.

### `autostart enable` / `autostart disable` / `autostart status`

Start Clankie when you log in. `enable` writes the user LaunchAgent
`~/Library/LaunchAgents/bot.clankie.autostart.plist` and loads it into your
`gui` domain. At login it runs this install's launcher as
`clankie restart clankie`, so the service, the relay, and the selected Discord
body start in dependency order and the launcher's supervision owns them from
there. launchd launches it once (`RunAtLoad`, no `KeepAlive`), and only inside a
logged-in session: a Mac waiting at the login window starts nothing. On a
release install the agent records the `current` launcher path, so upgrades need
no re-enable. It also records your `PATH`, `XDG_CONFIG_HOME`, and
`XDG_STATE_HOME` as they were when you enabled it; run `enable` again after
changing them. `enable` is idempotent (a loaded agent is booted out first) and
`disable` unloads and removes the agent.

```json
{
  "ok": true,
  "status": "enabled",
  "label": "bot.clankie.autostart",
  "plist": "/Users/me/Library/LaunchAgents/bot.clankie.autostart.plist",
  "loaded": true,
  "command": ["/Users/me/.local/share/clankie/current/bin/clankie", "restart", "clankie"],
  "log": "/Users/me/.local/state/clankie/autostart.log"
}
```

`status` is `enabled`, `disabled`, or `stale` (the agent file and launchd
disagree; run `enable`). The job's own output lands in `log`; the services keep
their usual per-process logs.

<a id="awake"></a>

### `awake [status|on|off]`

Keep this Mac awake while it is plugged in, so Discord and the app stay reachable
([always-on guide](always-on.md), [ADR 0203](adr/0203-clankie-keeps-what-better-models-cannot-absorb.md)).
`on` stores the opt-in (`host.keepAwake` in settings) and starts a
launcher-supervised `caffeinate -s` now; `off` clears it and stops that process.
macOS holds a `-s` assertion only on AC power, so unplugging lets the Mac sleep as
its own settings say. The opt-in survives a restart: the launcher restarts
`awake` with the clankie service, so [`autostart`](#service-lifecycle)
brings it back at login. It never runs `pmset` with anything but `-g` and never
changes a power setting. Local only; hosted mode and non-macOS hosts refuse
`on`. The console has the same command as `/awake [on|off]`.

```json
{
  "ok": true,
  "keepAwake": true,
  "service": { "state": "healthy", "detail": "holding this Mac awake while plugged in", "pid": 4242 },
  "power": {
    "state": "always_on",
    "source": "ac",
    "sleepAfterMinutes": 10,
    "heldAwakeBy": ["caffeinate"],
    "keepAwakeRequested": true
  },
  "note": "Keeps this Mac awake only while it is plugged in; …"
}
```

`service.state` is `healthy` when off or holding, and `unreachable` when
requested with no `caffeinate` running (`clankie restart awake`). A `caffeinate`
you started yourself is never touched and never counted as the launcher's.

<a id="device-setup"></a>

### `pair [--json] [--timeout SEC] [--review --days N [--count N]]`

Mint a one-time pairing offer (QR + code + deep link) for the phone/desktop
app. Pairing reuses a healthy app relay or starts a stopped one before minting
an offer. If the relay cannot start, no offer is minted. A configured public
doorway carries the offer, so when this Mac has no live connection to it —
`doorway.state` anything but `connected` — pairing fails `unavailable` rather
than handing out a code the phone can only report as unrecognized, unless a
direct route is configured: then the offer carries that route alone (ADR 0204).
`--timeout` covers
startup and minting together and defaults to 30 seconds; an ordinary offer
lives five minutes. A remote `CLANKIE_CONTROL_PLANE_URL` fails with
`unavailable`: run pairing on that host so its launcher can verify the relay.
The console's `/pair` runs this same command and accepts the same flags.

Public-gateway pairing uses a secure QR or full pasted link; the encryption
credential is in its fragment. Short codes are for direct private connections.
One link carries every route the Mac has (ADR 0204): the gateway fragment when
remote access is on, and `direct=<origin>` when `clankie gateway direct` has
configured a device-reachable control origin. With a direct route, the App
Store app pairs without a Clankie account. It uses the gateway first when both
are present. Human output ends with `Routes: remote access (gateway) + direct
(<origin>)`, one of them, or `Route: this Mac only`, which pairs only a source
build. It warns when the App Store app cannot reach the direct origin: plain
HTTP works only for `.local`, single-label and private IP addresses, so serve
tailnet names over HTTPS (`tailscale serve --https`). The service reaches the
LAN only through the opt-in device doorway (`CLANKIE_DEVICE_HOST`,
`CLANKIE_DEVICE_PORT`, default 4311), which serves device routes alone.
Human mode writes the QR and code/link to stdout. Those values are secret-bearing
display data — never log or persist them. `--json` is the agent form; `routes`
is omitted when the link carries neither route:

```json
{
  "ok": true,
  "code": "ABCD-EFGH",
  "deepLink": "clankie://connect?v=1&offer=…&direct=…",
  "expiresAt": "2026-08-30T12:00:00.000Z",
  "routes": { "gateway": false, "direct": "http://my-mac.local:4311" }
}
```

`--review --days N` mints a review offer for App Review or a TestFlight tester
who will pair hours or days later: `--count` (default 3, max 10) independent
single-use offers that each live `N` days (max 31, the public gateway's route
window) and survive a Clankie restart. Human output is headed `REVIEW OFFER`
and lists `Code 1…N`; `--json` is
`{ "ok": true, "review": true, "expiresAt": "…", "offers": [ { "code", "deepLink", "expiresAt" } ] }`.
For public pairing, send each offer's secure QR or full link, not its displayed
short code. The `Code 1…N` labels are CLI display labels; short codes remain
usable only over direct private connections.
Mint review offers only after the public gateway release that accepts them;
an older gateway drops the Mac connection on the first review route.

Failure with `--json`: `{ "ok": false, "status": "unavailable"|"unauthorized"|"expired"|"malformed"|"interrupted", "error": "…" }`.
Without `--json`, the same message goes to stderr and stdout stays empty when
no offers were minted. If a review batch fails after minting some offers, the
command still exits 1 and displays those live offers: JSON adds `partial: true`,
`review: true`, and `offers`; terminal output starts with `PARTIAL`. Each offer
remains usable until consumed or expired through its supported pairing path.

### `devices [--json]`

List paired devices. Human mode is a table whose `SOURCE` column reads `review`
for devices paired through a review offer (revoke those after the review) and
`pair` otherwise; `--json` is `{ "ok": true, "devices": [ … ] }` with
`"review": true` on those rows. Empty human output is `No paired devices.`
The `PUSH` column shows `enabled` for an active device with chat access and an
enabled delivery reference, otherwise `off`. This is the host's registration
state, not proof that Apple delivered a notification. JSON includes the optional
`push` object with `registrationId`, `sequence`, and `enabled`; disabled records
retain their last version. The phone authorizes delivery and controls notification
permission. The hosted gateway holds the APNs signing key and delivery registrations.

### `devices revoke <id> [--json]`

Revoke one device. Human: `Revoked <id> (<name>).` JSON: `{ "ok": true, "device": { … } }`.

### `gateway [status]` / `gateway set --url URL --host-id ID` / `gateway disable`

`clankie gateway rotate-encryption-key` replaces the broker key wrapping device
tickets. It reports the required captain restart without performing it. Coordinate
that restart, then re-pair every device. The `/gateway` menu exposes the same
action. [Encryption contract](adr/0173-the-gateway-cannot-read-device-traffic.md).

Read the public doorway binding or disable it. JSON includes `publicGateway`,
the derived `hostId`, `credentialPresent`, `enabled`, `settingsFile`, the
restart command, and `doorway` — the running captain's own view, read over
loopback, because stored settings never prove the socket is up. Its `state` is
`connected`, `connecting`, `sign_in_required` (with the `since` timestamp; no
app reaches this Mac until someone signs it back in), `unavailable` (configured,
but this Clankie holds no connector at all), `disabled`, or `unreachable` when
the captain does not answer. Use the interactive TUI `/gateway` wizard to sign in with an
invited email and one-time code; the rotating account credential goes to
Keychain and the wizard restarts Clankie automatically. `disable` signs this Mac
out and removes its installation binding.

After sleep or an offline startup, the account connector backs off until the
account endpoint responds to a harmless reachability probe. Lost refresh replies
get up to three quick retries with the same token inside the rotation grace
window. Network failures keep the doorway `connecting`; an explicit credential
rejection parks it at `sign_in_required`, visible in `/gateway` and `doctor`,
until the owner signs in again. Sleeping through the entire grace window cannot
recover a replacement token whose reply was lost.

`set --url URL --host-id ID` remains only for legacy static-bearer migration and
local verification. It never accepts a secret as a flag.

### `linear post comment|issue --json-stdin`

Publish through the operator tool bank as an existing worker persona using
the connected Linear app. Input is JSON with `personaId`; comments also need
`issueId` and `body`, issues need `teamId` (UUID) and `title`. The service derives
the name and colored Clankie portrait from the fleet. Output includes the MCP
result and `ok`; provider/tool rejection sets `ok: false` and exits nonzero.
See [worker posts](linear-worker-posts.md) for examples, grants and limitations.

### `linear status` / `linear follow on|off`

When a webhook is configured, accepted events appear in the **Linear inbox**
conversation (`linear-inbox`) as **External activity** messages, including swarm
posts delivered by the webhook. Workspace webhook events are passive history. Clankie also reads the connected
account’s actual Linear notifications once at startup and when webhooks arrive.
There is no periodic poll. A newly persisted, signed workspace event (or a verified exact self echo) requests a
refresh after a 1.5-second debounce; if no new notifications appear, it retries
once after another 1.5 seconds. Refreshes coalesce bursts and never overlap an
active read. A failed startup or manual read gets one delayed catch-up attempt;
a failed retry retains its checkpoint for the next webhook or restart.
Following requires a configured webhook. Following controls
whether those notifications wake his operator conversation:

| Following     | Inbox delivery                          | Automatic model turns                            |
| ------------- | --------------------------------------- | ------------------------------------------------ |
| Off (default) | Events stay visible in the conversation | None from incoming events                        |
| On            | Events stay visible in the conversation | Rule-matched notifications wake `global-default` |

Notifications wake only after attribution from signed webhook history and matching
`linearWebhook.wake`. Defaults select configured owner humans only and exclude
`issueSubscribed`. Clankie's own account and workers are quiet unless explicitly
selected; unknown or ambiguous actors stay quiet. Collection is unchanged
([ADR 0214](adr/0214-linear-wakes-require-attribution-and-rules.md)).
Mentions, assignments, subscribed issue activity and replies follow Linear’s
own inbox semantics. No per-issue binding is needed. The first connection starts
watching from now; existing Linear notifications remain readable with
`linear_get_notifications`. Notification IDs and a private durable checkpoint
prevent restart, pagination and read-state changes from creating extra wakes.
Unavailable connections are retried without waking; no human connector is used.

Open the conversation with `clankie --chat linear-inbox`. It is created on the
first accepted event, including while off. Ask Clankie to **check the Linear
inbox** when you want him to read its retained messages; collecting them does
not automatically load them into model context. Turning following on does not
schedule a turn for every old message. Unread events survive retention; normal conversation retention bounds consumed
history.

`clankie linear inbox read` (or `clankie linear inbox`) returns a JSON page
in `items`: the oldest unread events, 20 by default (`--limit N`, up to 100),
under 31 KB serialized. `--headlines` returns one line per event (cursor,
time, headline) instead of the quoted payload; `--before CURSOR` returns the
events just before that cursor, read or not, so history can be walked back
from `oldestCursor` as deep as wanted. Reading leaves events unread. Review
what was shown, then run `clankie linear inbox ack CURSOR` with the returned
`ackCursor`; it moves the read boundary forward over events already offered,
never past one unseen. Never acknowledge truncated output. Unacknowledged
pages survive restart. `GET /v1/linear/inbox?limit=&before=&headlines=1`
reads; `POST /v1/linear/inbox` requires `{ "ackCursor": "..." }`.
Following controls waking, not collection.

`clankie linear follow off` suppresses new event-triggered turns and skips model
turns still queued; their inbox messages remain. An already-running turn can
finish. `clankie linear follow on|off` applies without a restart, and
`clankie linear status` reports the switch and webhook readiness. All three
return JSON with `ok`, `following`, `active`, `webhookConfigured`, `reason`,
`missingWebhook`, `detail`, `conversationId` (`linear-inbox`),
`wakeConversationId` (`global-default`), and `settingsFile`. Enabling without a
stored webhook URL or signing secret leaves the switch unchanged and returns
`ok: false`, `error: "linear_webhook_required"`, and a nonzero exit status.
`missingWebhook` names `url`, `secret`, or both, with setup guidance in `detail`.
`PUT /v1/linear/follow` refuses with HTTP 409 and the same reason; its authenticated
GET reports readiness. Removing a prerequisite while following is on reports
`following: true`, `active: false`, and `reason: "linear_webhook_required"`, also
shown plainly in the TUI. Turning following off always remains available.

Notifications wake the operator conversation or its attached native seat. All
records remain in one canonical inbox. `--conversation global-default` scopes
reads and acknowledgments to that stream; omitting it reads all retained history.
Removing the webhook stops ongoing notification refreshes and workspace history
delivery; disconnecting Linear stops notification reads. Startup and queued wakes
recheck webhook readiness. Following off keeps webhook ingestion and notification
collection enabled. Readiness checks local configuration, not delivery health or
whether someone deleted the webhook in Linear's own settings.

Configure the webhook from `/connect linear` → **Follow Linear** → **Configure
webhook**. The flow prints and stores the registered public URL in
`linearWebhook.url`, and stores the signing secret in the credential broker
(`linear-webhook`). In Linear's webhook settings, select **all
available activity events**, including issues, comments, projects, and updates.
An existing Comments-only webhook also needs its event selection expanded there.
Setup does not enable following; **Start following** / **Stop following** is a
separate choice under **Follow Linear**, enabled only once both are configured.
Existing setups that stored only a secret must run **Configure webhook** again
and choose **Keep it**, or record the already-registered URL with
`clankie linear webhook set --url URL`. `clankie linear webhook clear` removes the
stored URL and leaves any requested following visible as blocked. The secret
remains broker-owned; it is never a CLI flag.

The consumer accepts signed `create`, `update`, and `remove` activity from any
resource type and actor. A verified, matching revision of Clankie's own MCP write
is dropped at ingress; matching delegated-worker updates retain their provenance
and enter the inbox. Ambiguous events remain visible. A wake carries
one headline per new event; the stored message carries the resource, action,
author, URL, data and previous values as bounded untrusted context.
Shared-account agent posts are not attributed to the human. Clankie decides
what merits attention; routine updates need no acknowledgment, dispatch or
reply. A delivery supplies context, not new permission.
[ADR 0168](adr/0168-linear-awareness-is-opt-in.md) describes the decision.

The local operator API exposes `GET /v1/linear/follow` and
`PUT /v1/linear/follow` with `{ "following": true | false }`. Both require the
operator bearer and return `{ "schemaVersion": 1, "following": boolean,
"conversationId": "linear-inbox", "wakeConversationId": "global-default" }`. The signed public ingress remains
`POST /v1/hooks/linear`. Changing the local follow switch does not change which
events Linear sends; the owner configures that subscription in Linear.

#### `linear wake [show|set …]`

Bare `/linear` opens **Follow Linear**. Its **Wake rules** editor is also under
`/connect linear` → **Follow Linear**. Rules are stored beside the follow switch
in `linearWebhook.wake`; following must still be active for a wake.

```sh
clankie linear wake show
clankie linear wake set --owner-user-ids OWNER_LINEAR_ID
clankie linear wake set --actors owner,self --types issueMention,issueCommentMention
clankie linear wake set --actors owner --types none --exclude-types issueSubscribed
```

`set` flags change only the specified fields. Values are comma-separated; `none`
clears a list. `--json-stdin` instead replaces the whole rule object, with defaults
for omitted fields. The result is `{ "ok": true, "wake": {…}, "settingsFile": "…" }`.
Malformed flags or rules fail without writing.

| Flag               | JSON field                  | Meaning / default                                                                     |
| ------------------ | --------------------------- | ------------------------------------------------------------------------------------- |
| `--owner-user-ids` | `ownerUserIds`              | Explicit owner Linear IDs; initially empty, so configure before expecting owner wakes |
| `--actors`         | `actors`                    | Any of `owner`, `human`, `self`, `users`; default `owner`                             |
| `--user-ids`       | `userIds`                   | Named IDs selected by `users`; initially empty                                        |
| `--types`          | `notificationTypes`         | Included notification types; empty allows all                                         |
| `--exclude-types`  | `excludedNotificationTypes` | Exclusions always win; default `issueSubscribed`                                      |

`human` requires a signed `user` actor type and excludes the connected account
and attributed workers. `owner` additionally requires an owner ID match. `self`
selects the connected account/app and attributed workers. `users` selects exact
IDs, including an app ID if explicitly listed. Selectors are ORed; names, email,
and notification subtitles never identify a human. Find an owner's ID through
Clankie's connected `linear_get_user` tool; the app's own account ID is not the
owner. No personal IDs are built into defaults.

`GET /v1/linear/wake` returns `{ "schemaVersion": 1, "wake": {…} }`.
`PUT /v1/linear/wake` accepts the rule object directly and replaces it, using
schema defaults for omitted fields. Both require the operator bearer. Invalid
rules return 400. API, CLI and TUI changes apply to the next notification decision
without a restart. Already collected notifications are never replayed or promoted;
turns accepted before a rule edit retain their decision. Use `follow off` to stop
queued turns too.

Attribution uses a durable, bounded index of verified webhook history (seven days,
at most 2,000 events), including exact self echoes even when receipt suppression
keeps them out of the inbox. It matches workspace, resource URL/issue identifier,
comment anchor when present, and action time within five seconds before or one
second after the notification. Relevant comment/state/assignment event checks
narrow candidates. Conflicting or missing actors produce no attribution.
Unmatched notifications remain collected without waking, including after journal
pruning or when notifications arrive before their webhook. No OAuth credential
is sent to GraphQL. This index does not change inbox retention or acknowledgment.

#### Issue ownership

Issue bindings are legacy metadata and no longer route events or notifications.
`clankie linear work list` and `GET /v1/linear/work` still show existing records.
`work bind` and `work unbind` are retired; authenticated `PUT` and `DELETE`
requests return `410` with `linear_work_bindings_retired`. Existing records are
not rewritten or deleted and no longer pin conversations against retention or
explicit deletion. Eligible notifications wake `global-default`.
Use `clankie linear inbox read --conversation global-default` and retain the
same conversation on `inbox ack`. Omit the conversation to inspect all history.
Never acknowledge truncated output or a cursor offered to another conversation.

The Claude seat denies the inherited `linear-server` MCP server with Claude
Code’s server-prefix permission rule. It uses Clankie’s connected `linear_*`
tools as the owner-connected account. Whatever tracker identity the owner connects
is the identity of Clankie and every worker he hires, across Claude, Codex and pi.
No email, display name or installation-specific user ID selects that identity.
Worker tracker writes use his granted broker connection; without a grant, the
worker asks the lead to write rather than using an independent harness account.
The remaining automatic worker-isolation work is specified in
[worker tracker identity](worker-tracker-identity.md).

<a id="account-setup"></a>

### `accounts codex [list | add HOME --label LABEL | remove LABEL]`

Register the owner's extra Codex homes, without copying or inspecting credentials:

```sh
clankie accounts codex add ~/.codex-second --label second
clankie accounts codex list
clankie accounts codex remove second
```

The TUI accepts the same arguments under `/accounts codex`. The owner signs in
and approves hooks in each home through Codex itself. Registration stores only a
canonical home path and label; `authPresent` checks file existence, not whether
the login is valid. `default` is implicit (`CODEX_HOME`, otherwise `~/.codex`).
Removing a registration never deletes its home or credentials.

Account reads also report `hookTrust`: `ready`, `review_required`, or `unknown`,
from Codex’s read-only `hooks/list` query for that home. Unsupported or failed
queries stay unknown. This checks home hooks, not trust for a future repository.
Selection still follows headroom; review stale hooks in the selected account’s
native Codex UI. No hook hashes or trust approvals are written by this check.

If a hired Codex TUI is waiting on hook or folder trust, the hire reports
`trust_required` when the prompt is visible. Its pane and app-server stay alive,
and its original brief continues once the owner completes review. A slow startup
without a recognized prompt reports `start_unconfirmed` with the same pending
explanation. Do not repeat the hire; inspect the existing pane. Closing that pane
cancels its pending startup.

Local Codex hires choose the greatest minimum remaining fraction across the
windows Codex reports (some plans report only a weekly window). The read-only
`account/rateLimits/read` query uses each home without starting a model turn.
If unavailable after ten seconds, recent rollout `rate_limits` provide a fallback.
Missing usage or fallback observations older than 24 hours are unknown, not free quota.
Known positive headroom wins over unknown; unknown wins over exhausted accounts;
registration order breaks ties. Passed reset times restore the corresponding
window. If all accounts are exhausted the least constrained one is returned;
Codex still enforces its quota. No credentials present means the hire fails.
`hire_agent`'s `account: "second"` pins a registered label (including `default`),
even when it has less headroom. Overrides on remote or non-Codex hires fail.
The hire result and fleet roster carry `seat.account: {label, home}`; the app
shows the label. Existing seats keep their account. New registrations apply
without a service restart.

The owner-authorized API offers `GET /v1/accounts/codex` and
`POST /v1/accounts/codex` with `{op:"add", home, label}` or `{op:"remove", label}`.
Local transcript discovery, `clankie agents`, resumed sessions and follow-up
queue delivery use the account's home; seat-sync uses the hook's transcript path.

### `accounts [list]` / `accounts connect github` / `accounts disconnect PROVIDER` / `accounts apps`

The owner's own GitHub and Linear accounts, linked to this body
([ADR 0196](adr/0196-account-connections-keep-tokens-on-the-body.md)). The
service runs each flow and keeps the token in the credential broker (`github`,
`linear`); nothing here prints a token. `accounts` lists each provider's
`status` (`connected`, `not_connected`, `unconfigured`), account, scopes and
where to manage it. `accounts connect github` prints the code to type at
GitHub on stderr, polls at GitHub's interval, and returns the connection.
`accounts disconnect github|linear` revokes at the provider when it can and
always deletes the local token; `revoked: false` comes with the `manageUrl`
to revoke by hand. Linear connects from `/connect linear` on a Mac, or from the
app through `/v1/accounts/linear/start` and `/complete`.

For worker names and portraits, use a workspace-owned app:
`accounts connect linear-app --client-id ID --secret-stdin`. The secret enters
through stdin and is verified and stored by the service, never returned.
`/connect linear` also offers **Connect a Clankie app**. `accounts list` reports
the verified `actor` and `workspace`. This replaces the one Linear connection
and requires new worker grants. Setup and scope: [worker posts](linear-worker-posts.md).

`accounts apps [set|clear] [--github-client-id ID] [--linear-client-id ID]
[--linear-redirect-uri URL]` reads or writes the public OAuth client settings
(`oauthApps` in `settings.json`); they apply without a restart.
`CLANKIE_GITHUB_OAUTH_CLIENT_ID`, `CLANKIE_LINEAR_OAUTH_CLIENT_ID` and
`CLANKIE_LINEAR_OAUTH_REDIRECT_URI` override them, which is how a hosted body
is configured. GitHub revocation needs the OAuth app's client secret as the
broker entry `github-oauth-app`.

### `voice [status]` / `voice model set MODEL_ID` / `voice model clear`

The headless launcher now supports inspecting voice settings and changing only
an already configured ElevenLabs model. Earlier builds exposed `/voice` only
inside the console and rejected `clankie voice`.

`voice status` returns `voice` (stored), `effectiveVoice`,
`overriddenByEnvironment` (environment variable names), `settingsFile`, and
`restart`. No credential is returned. Model writes preserve the voice ID,
realtime provider, consent and all other settings; they never restart services.
Select the provider and voice ID with the console's `/voice` first.

```bash
clankie voice status
clankie voice model set eleven_v4_turbo
# After reviewing settings and arranging an interruption of active calls/work:
clankie restart clankie
```

`eleven_v4_turbo` selects Text to Dialogue multi-context WebSocket synthesis.
An unset model retains `eleven_flash_v2_5` on the legacy TTS transport. To roll
back an originally unset model, use `clankie voice model clear`, then the same
restart. If a model was explicitly set, restore it with `model set ORIGINAL_ID`.
Environment overrides still win: check `effectiveVoice` before restarting.
This command is local-only; hosted mode refuses it. See the
[voice operating guide](../apps/discord-bridge/README.md) for verification limits.

### `work [status]` / `work init` / `work list|show|create|update|close|attach`

Tracks work where the repo already does ([ADR 0191](adr/0191-work-is-tracked-where-the-repo-tracks-it.md)):
its Linear team (through the Linear account connected to Clankie), its GitHub
issues (through the owner's `gh` login), its own one-file-per-item Markdown
directory, or `.clankie/work/` when it has none. Every command runs against the
git repo containing the current directory, or `--repo PATH`, and prints JSON.
It is the same contract as Clankie's `work_items` and `work_item_write` tools,
and every assignment brief tells a hire to use it.

- `clankie work` (or `work status`, `work discover`) reports the repo's signals,
  its recorded convention if any, and a `question` when discovery found more
  than one tracker or only a single `TODO.md`. Answer it once with `work init`.
- `clankie work init` records what discovery found; `work init --backend
default|markdown|github|linear [--directory D] [--github-repo OWNER/NAME]
[--linear-team KEY] [--linear-project NAME] [--note TEXT]` records the owner's
  choice. The answer is written to `.clankie/tracking.json` in the repo; nothing
  else is added to a repo that tracks work elsewhere.
- `clankie work repos` lists the repos registered on this machine. A repo is
  registered the first time a local command names it; only registered repos are
  readable from a paired device.
- `clankie work list [--status todo,in_progress] [--owner NAME] [--label L]`,
  `work show ID`. `--label` keeps items carrying that label, matched
  case-insensitively; it is how a role station reads its backlog
  ([ADR 0208](adr/0208-agents-carry-a-role-the-world-reads-it.md)). Items carry
  `labels` from the backend: Linear labels, GitHub labels (without the
  `status: …` labels this backend writes), or a Markdown item's `labels:` front
  matter (`[a, b]`, `a, b`, or a YAML block list).
- `clankie work create TITLE [--summary S] [--owner NAME] [--criterion C]...
[--status S]`.
- `clankie work update ID [--status S] [--owner NAME | --no-owner] [--title T]
[--check N]... [--uncheck N]... [--add-criterion C]...`; criterion numbers are
  1-based and may be comma-separated.
- `clankie work close ID [--canceled]` sets `done` (or `canceled`).
- `clankie work attach ID --url URL --caption TEXT [--kind image|video|log|link]`
  appends evidence; the kind is inferred from the URL when omitted.

Statuses are `todo`, `in_progress`, `in_review`, `done` and `canceled`,
projected onto each backend's own states. A recorded backend that cannot be
reached answers `backend_unavailable` and never falls back to files. The HTTP
form is `POST /v1/work` with the operator bearer and `{ "action": ... }`.

### `operator-credential rotate [--json]`

Mint a new local operator bearer. Existing operator sessions are invalid
immediately. JSON: `{ "ok": true, "status": "rotated", "source": "store" }`.
The new secret is not printed.

### `play status`

The live embodiment session (`GET /v1/embodiment/sessions/live`). JSON
`{ "session": … }` or `{ "session": null }`. Requires an operator credential;
start the clankie service once if none exists.

### `play stop`

Operator kill-switch (`POST /v1/embodiment/sessions/live/stop`). The play host
winds down at the next turn boundary — this is not a process kill. A live
session returns JSON. Idle is the sentence `Nothing is playing.` (exit 0, not
JSON).

### `rivals`

`rivals connect URL [--token-stdin]` / `disconnect` configure the Rivals Agent origin live; its
token is broker-owned under `rivals-agent` (`/auth rivals-agent`). `rivals status`
reads the current sitting. `rivals start autonomous|combat|disengage [NOTE]` starts
a bounded sitting. `rivals objective SESSION MODE [NOTE]`, `observe SESSION`,
`share SESSION [GUILD CHANNEL]`, and `stop SESSION` require its observed ID.
All return JSON; a refusal exits 1. `/rivals` exposes the same commands in the TUI.
Notes are context, not instructions the current scripted policy understands.
See [Rivals setup and verification](rivals.md).

<a id="model-setup"></a>

### `model [status]`

Paired apps, including hosted bodies without a terminal, use the same catalog,
credential broker and captain selection through the [owner model-key API](model-keys.md).

Captain model and every config-declared provider. JSON:

```json
{
  "ok": true,
  "model": "ds4/deepseek-v4-flash",
  "effort": "high",
  "providers": {
    "ds4": { "baseURL": "http://127.0.0.1:8000/v1", "models": ["deepseek-v4-flash"] }
  },
  "restart": "clankie restart captain"
}
```

`ok` is false and exit 1 when `clankie.json` has load issues (`issues` is then
present). `model` and `effort` are `null` when unset. The running service does
not pick up a write until `clankie restart captain`.

### `model add-local --id ID --base-url URL [--context N] [--models id,id] [--set]`

Declare a credential-less OpenAI-compatible local runtime (ds4, Ollama, LM
Studio, vLLM, llama.cpp) into global `clankie.json`. The TUI
`/provider` → “add a local endpoint…” flow uses the same writer.

| Flag         | Meaning                                                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--id`       | Provider id. Lowercased. Letters, digits, `.`, `_`, `-`; no slashes.                                                                                |
| `--base-url` | `http://` or `https://`. A bare origin is rewritten to `/v1` (`http://127.0.0.1:8000` → `http://127.0.0.1:8000/v1`). Trailing slashes are stripped. |
| `--context`  | Fallback context window in tokens when the probe does not report one. Default `32768`. Must be a positive integer.                                  |
| `--models`   | Comma-separated model ids used when the probe returns nothing.                                                                                      |
| `--set`      | Select the first listed model as captain (`providerId/firstId`).                                                                                    |

The probe is `GET {normalizedBaseURL}/models` with a 3-second timeout. Local
runtimes are unknown to models.dev, so the endpoint itself is the catalog.

```bash
clankie model add-local --id ds4 --base-url http://127.0.0.1:8000 --set
```

```json
{
  "ok": true,
  "providerId": "ds4",
  "baseURL": "http://127.0.0.1:8000/v1",
  "models": ["deepseek-v4-flash", "deepseek-v4-pro"],
  "model": "ds4/deepseek-v4-flash",
  "restart": "clankie restart captain"
}
```

If the probe fails and `--models` was given, the write still succeeds and the
payload includes `probeError`. If the probe fails or lists nothing and
`--models` was omitted, exit 1 with `{ "ok": false, "error": "…" }`.

The local runtime is **not** a launcher-owned service. Start ds4, Ollama, or
LM Studio yourself; `clankie restart captain` only reloads Clankie's config.

### `model set providerId/modelId`

Select the captain. The ref splits on the **first** slash (model ids may
contain slashes). JSON: `{ "ok": true, "model": "xai/grok-4.6", "restart": "clankie restart captain" }`.

### `model refresh`

Refresh the available model catalog. Use this when a newly released model is
missing: the captain, gameplay, and commentary otherwise read the installed or
cached catalog. The TUI's `/model` and `/provider` offer the same refresh.
Restart the captain afterward with `clankie restart captain`.

JSON contains `ok`, `source` (`network`, `cache`, or `bundled`), `updated`,
provider and model counts, and the restart command. A successful network refresh
exits 0. If the network fails or fetching is disabled, the existing catalog
remains usable, but refresh returns `ok: false` and exits 1.
`CLANKIE_DISABLE_MODELS_FETCH` and an explicit `CLANKIE_MODELS_PATH` skip fetching.

For Astra, run `clankie model refresh`, then
`clankie model set openai-codex/gpt-6-astra` and `clankie effort set high`.
The supported efforts are `low`, `medium`, `high`, `xhigh`, and `max`.
Captain, gameplay, and commentary use the selected model; voice and image/video
generation keep their separate selections.

Verified transport settings (2026-09-04):

| Provider/model             | Transport        | Configured context / maximum output |
| -------------------------- | ---------------- | ----------------------------------- |
| `openai-codex/gpt-6-astra` | Codex Responses  | 400,000 / 128,000 tokens            |
| `openai/gpt-6-astra`       | OpenAI Responses | 1,050,000 / 128,000 tokens          |

The subscription context value is conservative, not a measured backend ceiling.
A local/self-hosted `openai` selection uses the subscription when available; disable the
`openai-codex` provider to select the metered API transport explicitly.
In a checkout, `pnpm --filter @clankie/clankie verify-model provider/model@effort`
checks a captain tool-and-image turn, a gameplay action, and commentary using
isolated settings. It makes live provider requests. Add `--metered` for the API
transport or `--json` for a machine-readable receipt. A provider error fails that
path's check with the provider's message, and any failed check exits 1. `--config-home PATH`
checks the selection previously written by the CLI under that configuration
home. The owner's live selection remains unchanged.

### `model routing [status]`

Task-based model routing ([ADR 0192](adr/0192-model-routing-by-kind-of-task.md)).
Everyday turns run on a cheap routine model; real work stays on the captain
model. Off until a routine model is set; off, every turn runs on `model` as
before. JSON:

```json
{
  "ok": true,
  "enabled": true,
  "routineModel": "openai/routine-model",
  "workModel": "openai/gpt-6-astra",
  "escalate": true,
  "escalationModel": "openai/gpt-6-astra",
  "routineTurnLimit": 12,
  "purposes": {
    "operator": { "tier": "work", "model": "openai/gpt-6-astra" },
    "discord_social": {
      "tier": "routine",
      "model": "openai/routine-model",
      "escalatesTo": "openai/gpt-6-astra"
    },
    "discord_granted": { "tier": "work", "model": "openai/gpt-6-astra" },
    "gameplay": { "tier": "work", "model": "openai/gpt-6-astra" }
  }
}
```

| Purpose           | Which calls                                                         | Default tier |
| ----------------- | ------------------------------------------------------------------- | ------------ |
| `operator`        | Operator conversations, their wakes, watches and side conversations | `work`       |
| `discord_social`  | Discord text or voice turns without machine tools                   | `routine`    |
| `discord_granted` | Discord turns holding machine tools, and the Herdr watches they arm | `work`       |
| `gameplay`        | The play mind and its commentary                                    | `work`       |

Every verb prints the status above after writing. Writes take effect on the
next turn (the next play session for `gameplay`); no restart is needed.

| Command                                                       | Effect                                                                                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `model routing set providerId/modelId`                        | Choose the routine model; turns routing on                                                  |
| `model routing off`                                           | Remove the routine model; every purpose returns to `model`. Other routing settings are kept |
| `model routing escalate on\|off [--model providerId/modelId]` | Let a turn move to the escalation model once per turn (routine turns default to `model`)    |
| `model routing purpose PURPOSE routine\|work\|default`        | Override one purpose's tier                                                                 |
| `model routing turn-limit N\|default`                         | Model calls a routine turn may make before it escalates as looping (default 12)             |

With escalation on, a routine turn moves to the escalation model for the rest
of that turn when he calls `escalate`, when it reaches the turn limit, or when
the routine model fails with an error the runtime retries (the retry runs on
the escalation model). A permanent error does not escalate. A routine model that
cannot be served fails the turn by name; it never falls back to the work
model. A work turn (operator, granted Discord, gameplay) escalates too when
escalation is on and `--model` names a model other than the captain model, but
only when he calls `escalate`: never on the turn limit or a provider error, since
long work is normal there. This works without a routine model. Effort is per
model ref, so `clankie effort set LEVEL --model REF` sets the routine model's
effort. Hosted bodies receive routing from the fleet at start. The console's
`/routing` takes the same arguments.

### `model compaction [status]` / `model compaction set TOKENS` / `model compaction default`

When a long captain session compacts ([ADR 0195](adr/0195-hosted-requests-fit-the-model-proxy.md)).
Unset, included usage (the hosted `clankie/*` models) compacts at 250,000 tokens
and every other model at its own context window. Set, the threshold applies to
every model (at least 16,384 tokens, Pi's reserve). A live session picks the
change up on its next turn. JSON:

```json
{
  "ok": true,
  "compactAtTokens": null,
  "includedUsageDefault": 250000,
  "appliesTo": "included usage"
}
```

The console's `/compaction` takes the same arguments.

### `effort [status]`

Read the current captain model's stored effort override. JSON:
`{ "ok": true, "model": "xai/grok-4.6", "effort": "high", "restart": "clankie restart captain" }`.
`effort` is `null` when Pi uses its model-supported default.

### `effort set LEVEL [--model provider/model]` / `effort clear [--model provider/model]`

Set or remove the variant for the named model. Without `--model`, the currently
configured captain model is the target. The TUI `/effort` modal obtains the
supported levels from Pi and calls this writer.

The writer saves the requested effort. At execution, an unsupported effort is
refused by name with the supported ladder, consistently across captain,
gameplay, and commentary; it is never silently downgraded.

### `image-model [status]` / `image-model set provider/model` / `image-model clear`

Read, set, or clear the image generation model. JSON is
`{ "ok": true, "imageModel": "openai/gpt-image-2" }`; the value is `null`
when unset. Media generation loads this config per request, so no restart is
needed. The TUI `/image-model` command calls the same functions.

### `video-model [status]` / `video-model set provider/model` / `video-model clear`

The same contract for video generation, with a `videoModel` result field. The
TUI `/video-model` command calls the same functions.

### `persona [status]`

Return the complete owner-authored persona plus `settingsFile` and the restart
command. Character configuration grants no authority.

### `persona images status|set <folder>|clear`

Select an owner-authored image/video folder with `persona images set ~/Pictures/clankie-vibe`.
`status` previews filenames, roles, counts, source/base64 sizes, dimensions, video
durations, sample timestamps and viewable cached `sheetPath` paths, skips and load
errors; it never emits image bytes. `clear` clears the setting without deleting
files. Restart Clankie to apply changes (the command prints the reminder).

Top-level files are vibe; put physical character references in `appearance/`.
Only appearance references feed self-portraits. PNG/JPEG/WebP sources may be up
to 10 MiB; MOV/MP4/WebM up to 256 MiB / ten minutes. Videos require ffmpeg and
ffprobe and become one 5×2 contact sheet of ten evenly spaced samples each; audio
is ignored. Read sheets left to right, then top to bottom. Appearance loads first,
then vibe, filename-sorted: eight source slots and eight references total. Stills
fit within a 1024-pixel edge, sheets within 2000×800; both cap base64 at 128 KiB. The TUI `/persona` → Persona images
uses the same writer. The authenticated `/v1/operator/persona` API accepts
`imagesDir`; an empty string clears it. Hosted paths name folders on the body.
See [persona images](persona-images.md) for caching, voice, model support and A/B evaluation.

### `persona set [flags]`

Update one or more persona fields atomically:

| Flag                    | Value                                |
| ----------------------- | ------------------------------------ |
| `--display-name`        | 1–64 characters                      |
| `--aliases`             | Comma-separated names; `none` clears |
| `--character-notes`     | Up to 4,000 characters               |
| `--chattiness`          | `quiet`, `balanced`, or `chatty`     |
| `--reply-policy`        | `addressed` or `all`                 |
| `--live-message-window` | Whole number from 0 through 100      |

JSON contains `{ "ok": true, "persona": { … }, "settingsFile": "…", "restart": "clankie restart captain" }`.
The TUI `/persona` modal calls this same writer.

### `games [status]` / `games set on|off`

Read or set whether the PokeAgent MMO body is available. JSON contains the
`games.pokeagentMmoEnabled` boolean, `settingsFile`, and
`"restart": "clankie restart captain"`. The TUI `/games` command calls this
same writer.

### `browser tools` / `browser call TOOL JSON`

Inspect or call Clankie's Browser Use Pi tools with the operator credential:

```sh
clankie browser tools
clankie browser call browser_use_open '{"url":"https://example.com"}' --conversation CONVERSATION_ID
clankie browser call browser_use_javascript '{"code":"console.log(await page.info())"}' --conversation CONVERSATION_ID
clankie browser call browser_use_close '{}' --conversation CONVERSATION_ID
```

The same catalog and call contract are available at `GET /v1/browser/tools`
and `POST /v1/browser/call`. Native JavaScript requires machine authority;
native captain calls carry their admitted conversation binding. Direct operator
calls require `--conversation ID` (HTTP: `x-clankie-conversation-id`) naming a
runnable conversation. A bearer and arbitrary ID cannot create authority.
JavaScript variables persist
within a browsing burst; mode changes, idle close and worker timeouts reset
them. The SDK uses Clankie's private profile and workspace under
`~/.clankie/runner/browser/`. It discovers installed Chrome; set
`CLANKIE_BROWSER_EXECUTABLE` to use a particular Chrome/Chromium executable.
`CLANKIE_AGENT_BROWSER_EXECUTABLE` no longer applies. No browser model key is
needed: Clankie's existing model writes the code and the SDK executes it.

### `body status` / `body request JSON`

Inspect who holds Clankie's Discord mouth, voice/Go Live, browser, or play body:

```sh
clankie body status
clankie body request '{"action":"queue","resource":"browser","conversationId":"CONVERSATION_ID","text":"Notify me when the browser is free","ttlMs":300000}'
clankie body request '{"action":"ask","resource":"voice","conversationId":"CONVERSATION_ID","text":"Can you finish this voice stay?","ttlMs":300000}'
```

`GET /v1/body-leases` returns `{leases:[...]}` with resource, owning stable
conversation ID, expiry and `active`/`recovery_required` state. It accepts the
operator or an active paired device's existing observe grant. It exposes no
incarnation tokens, actor details, room text or request messages. The relay
forwards the same read with the original device bearer.

`POST /v1/body-leases` uses the strict JSON request above and operator authority
bound to the selected runnable conversation. Busy results name the holder and
retain typed `queue`/`ask` options. Queue wakes the requester after release;
ask delivers only the supplied text to the captured owner. Both expire, refresh
source and destination authority, and perform no body effect. Unknown legacy
owner routes cannot be redirected to a default room. A social request stays
social even if its actor later gains machine authority.

Acquire returns a private incarnation for renew/release. Ordinary release is
owner-only and confirms actual session termination; a token is not a stop
receipt. Explicit operator `recover` can stop a different owner's resource,
using the current private host claim. Expiry, restart, a stop request, or a
failed response does not imply termination. Uncertain operations remain held
until exact delivery or termination evidence resolves them. Recovery never
silently retries a Discord send.

### `browser [status]` / `browser record on|off`

Read or set `browser.recordSessions`. When on, each burst of Clankie's browsing
is saved as a WebM under `~/.clankie/runner/browser/recordings/`: recording
samples the current tab every 750 ms and stops after 60 seconds without
one; the newest 50 are kept. The browser then closes its tabs/windows while
keeping its private profile and persistent logins, even with recording off.
Browsing defaults to headless; explicit `headed: true` takeover lasts for that
burst, and the next burst starts headless. Changing modes saves the previous
recording before starting another. Off by default, because videos capture every page
he opens, signed-in ones included. JSON contains `browser.recordSessions`,
`settingsFile`, and `"appliesTo": "next_browsing_burst"` — no restart is needed.
The TUI `/browser` command calls this same writer.

### `browser harnesses` / `browser delegate on|off`

The computer-use harnesses on this machine that Clankie can hire for hard
computer and browser work
([ADR 0199](adr/0199-hard-computer-work-goes-to-a-computer-use-harness.md)).
`harnesses` asks the service (`GET /v1/browser/harnesses`, operator bearer),
which re-probes on every read: `codex login status` and `codex features list`
plus Codex's plugin config for Codex computer use and Chrome, and
`claude auth status` plus `~/.claude.json` and Chrome's native host for Claude
in Chrome. Nothing is started or driven. JSON contains `detected` (false on a
hosted body or a non-macOS host, where nothing is probed), `harnesses` (each
with `harness`, `signedIn`, `surfaces` of `desktop` and/or `chrome`,
`chromeNeedsHireFlag`, and `missing` saying what the owner does when it is not
ready) and `harnessDelegation`.

`delegate on|off` sets `browser.harnessDelegation` (default on): whether the
ready harnesses appear in the `reach` section of his prompt, on lanes with
machine access only. Turn it off to keep him from spending those plans. His own
browser is unaffected. JSON is the `browser status` shape with
`"appliesTo": "next_session"`. `/browser harnesses` and `/browser delegate on|off`
in the TUI call the same code. A listed harness is hired with `hire_agent`;
`chrome: true` starts claude with `--chrome`.

### `fleet [status]` / `fleet set [--notes TEXT] [--size SIZE] [--models MODE]` / `fleet clear`

Read, set, or clear how the owner wants work routed across the agents Clankie
leads — which harness is the workhorse, which one reviews, what never goes to
which (up to 4,000 characters of free text) — and the budget he sizes the fleet
to. `set` takes any combination of the three flags; what is left out keeps its
value. `clear` returns all three to their defaults.

**The budget is two targets, never caps.** Nothing counts seats against them; the
leadership skill (`lead`) and his prompt use them to aim.
An owner who wants a thousand agents picks `max` or says so in the notes.

| `--size`        | Fits                                                               | Aims for                                                                                                                                     |
| --------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `max` (default) | several top-tier plans, e.g. four or five $200/month subscriptions | maximum bandwidth: one worker per separable deliverable plus independent reviewers, as far as the work and machines can use them; no ceiling |
| `large`         | one or two top-tier plans                                          | around six concurrent workers, reviewers included                                                                                            |
| `small`         | one mid-tier plan, about $100/month                                | one or two workers at a time; the rest sequenced                                                                                             |
| `solo`          | pay-per-token API use                                              | no standing workers: he works himself or through short native subagents, and asks before a long or parallel run                              |

| `--models`          | Picks per job                                                                                                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `optimal` (default) | the strongest model and the effort the job needs; cost is not a reason to downgrade                                                                                                   |
| `efficient`         | the smallest model and lowest effort that still meet the job's acceptance; the top model stays on consequential boundaries (safety, data integrity, live surfaces, a disputed review) |

**The default notes are empty**, and empty means he picks a harness per job on his
own. Nothing here ships with an opinion; this is where you add one.

It is free text rather than a table of roles because an enum of
`reviewer`/`implementer` only covers the situations someone enumerated, and the
useful ones are conditional ("never codex on Swift", "grok for a hostile read on
work that already passed review"). The thing reading it is a model.

The notes reach him as the `fleet` prompt section, and only on lanes that hold a
shell — a room that cannot dispatch would carry the section for nothing. They are
preference, not authority: the section says plainly that he still reads the work
and decides, and a note here can no more widen his reach than a warmer persona
can. The section carries the swarm size and model mode whenever it renders. With
no notes and the default budget (`max`, `optimal`) there is no section at all.

JSON contains `{ "ok": true, "fleet": { "notes": "…", "size": "max", "models": "optimal" }, "settingsFile": "…", "restart": "clankie restart captain" }`.
The TUI `/fleet` command opens the same editor (size, then models, then notes)
and `/fleet status` prints the same values.

```bash
clankie fleet set --notes "codex is the workhorse. claude when it needs skills or long context. grok for a hostile read on work that already passed review. never codex on Swift."
clankie fleet set --size small --models efficient
```

<a id="runtime-setup"></a>

### `machines [list|discover] [--json]`

A machine is where agents run; a device is a paired phone or desktop portal.
`machines` prints one row per machine: Herdr sessions, state and worker count
(`?` when unavailable). `--json` returns `{ observedAt, machines }` from
`GET /v1/machines`. Discovery reads local Herdr sessions and literal aliases in
the owner's SSH config (including bounded `Include` expansion). Probes use BatchMode and strict known-host checking,
never prompt, start a server or install remote software. Four probes run at
most concurrently, with a three-second probe deadline and a 6.5-second listing
budget. Unreachable and still-discovering candidates remain visible. Results
are cached for fifteen seconds; `discover` refreshes them.

```bash
clankie machines add pc --ssh my-pc --shell powershell
clankie machines sessions pc
clankie machines sessions pc --connect work --id pc-work
clankie machines remove pc
```

Adding registers transcript access immediately and lists available sessions.
Connecting names an existing Herdr session; it does not start one. Removal
unregisters that machine's connections without stopping workers. Named and SSH
connections apply live to census, hires and watches. Default workspace changes
still require `clankie restart captain` (ADR 0172).

Named local workspace connections support Codex structured hires and resume on their
pinned socket. Claude structured hires on a named local workspace currently return
`harness_unavailable`: its worker channel is not configured for that socket. They
never launch through the default workspace or inherit its fleet grant. Removing a
connection releases cached control without stopping its native workers; retained
controllers cannot send or interrupt after removal or same-ID replacement.

Existing `herdr add/remove/fleets`, `runtime connect` and `agents hosts` remain
aliases. Machine records own transport; old connection IDs, transcript host
aliases, exact-directory grants and saved seat IDs survive migration. Devices
continue to use `pair` and `devices`.

The paired operator `connections` operation uses the existing `steer` grant for
`discover`, `add_machine` (`id`, `ssh`, optional `shell`), `remove_machine` and
`connect_runtime` (`id`, `session`, optional `machine`, default `local`). Its
inventory includes `machines` and a `machine` ID on every runtime row. Paired
metadata omits local socket paths.

### `connections` and `runtime`

`clankie connections` combines execution runtime health and the recorded
Linear account identity as JSON. Its
operator API is `GET /v1/connections`; the companion app shows it under
Settings, where it can also connect a local Herdr session by name.

In the TUI, `/connections` links to `/machines` and accounts. `/machines`
shows machine state and agent counts, discovered candidates before the typed-name
fallback, and each machine's connected and discoverable Herdr sessions. Connect
or disconnect named sessions live; retry disabled or unreachable connections while
keeping their saved session, transport, workspace grants and capacity.
Native worker harnesses are chosen per hire. `/runtime` with no argument opens
Machines, as does `/sessions`; saved transcripts open inside each machine. Both retain their arguments,
and `/connections json` prints the raw inventory.

Onboarding asks only how he thinks. Once ready, `/setup` offers the workspace
choice only when doctor finds installed Herdr with running sessions. His own
workspace is recommended; leading your session lets him see and message every
pane in it. `/herdr` default workspace changes still offer Restart now / Later.

```sh
clankie runtime list
clankie runtime connect build --session workers
clankie runtime connect review --socket /absolute/herdr.sock
clankie herdr --connection review agent list
clankie herdr --connection review open
clankie runtime disconnect review
```

`/runtime` accepts the same list/connect/disconnect commands. Connections pin an
ID to a verified socket and session label; use a new ID for a different endpoint.
Disconnect disables routing and retains identity without stopping any worker.
An unavailable named connection never selects another session. Native Herdr
commands/viewers require a local Clankie service. These managed launch routes
share the service's filesystem and executable paths. A Herdr fleet on another
machine is an ssh connection (`herdr add`, below); its agents reach Clankie
through that fleet's link.

For custom capacity/capabilities, `runtime connect CONNECTION.json` accepts
`{ "id": "build", "session": "workers", "capacity": 2, "capabilities": ["code"] }`.
A socket can replace `session`. `default` is reserved for the existing fleet;
`runtime:` capability names are reserved for explicit routing. Up to 15 named
connections are stored under `execution.connections`.
The operator API is GET/POST `/v1/runtime-connections` and DELETE
`/v1/runtime-connections/ID`; GET `/v1/herdr?connection=ID` resolves a live binding.

Approve additional execution locations for the default or a named runtime through
the operator API (the same commands work as `/runtime` in the TUI):

```sh
clankie runtime workspaces default --repo /absolute/project --dir /absolute/scratch
clankie runtime workspaces build --repo /absolute/project
clankie runtime workspaces build --clear
```

Runtime capacity defaults to 16. `clankie runtime capacity ID N` changes it;
`--clear` selects unlimited and `0` pauses new admission. The operator endpoint
owns these settings. `runtime status` reports the effective value and source.

Each call **replaces** that runtime's extra approvals; `--clear` restores the
conversation-directory-only default. `runtime list` shows the stored policy.
`--repo` pins the canonical Git common directory and accepts that repository's
currently registered checkouts, including newly created linked worktrees outside
the original directory. Stale approvals grant nothing; rejected requests identify
them as `stale_workspace` with `staleWorkspaces` details.
`--dir` permits only that canonical directory, never its children. Paths must be
absolute and exist on the service host. The runtime retains one capacity pool.
An ssh fleet is the exception: its grants are exact `--dir` paths on that
machine (a drive path such as `C:\src\rivals` for a Windows fleet), stored as
written, because this host can neither resolve nor stat them.

The operator-only POST `/v1/runtime-connections` accepts
`{ "action": "workspaces", "id": "default", "workspaces": [{ "kind": "repository", "path": "/absolute/project" }] }`.
Named `connect` JSON also accepts `workspaces`;
captain/Discord credentials cannot call this endpoint. Existing operator-machine
shell authority remains unchanged.

Use the actual approved checkout as `hire_agent.workingDirectory`. A remote
hire needs an exact remote directory grant. See
[ADR 0193](adr/0193-runtime-workspaces-are-owner-approved.md).

### `agents [list]` / `agents read` / `agents resume` / `agents hosts`

Clankie reads any Claude Code, Codex, Grok or Pi session from the
agent's own transcript, on this machine or an owner-configured SSH host. No
terminal host is involved: a session in Herdr, tmux, or a bare PowerShell tab
reads the same way
([ADR 0189](adr/0189-agent-sessions-read-from-their-transcripts.md)).

```sh
clankie agents hosts add pc --ssh volpe@supedupsilly --shell powershell
clankie agents                          # every host, newest first
clankie agents list --host pc --limit 5
clankie agents read pc:01a0da31 --tail 20
clankie agents read pc:01a0da31 --after CURSOR
clankie agents resume local:SESSION_ID
clankie agents resume pc:SESSION_ID --fleet pc --brief "Continue the task"
clankie agents hosts remove pc
```

A remote host needs only sshd and its default shell; nothing is installed there.
Authentication is the owner's SSH configuration (keys, `~/.ssh/config` aliases).
Reads are confined to `~/.claude/projects`, `~/.codex/sessions`, `~/.grok/sessions`
and `~/.pi/agent/sessions` on that host and capped at 4 MiB per call. `local` is always present. Hosts are stored under
`agentHosts.connections` (up to 15).

`list` reports `ref` (`host:sessionId`), harness, size and `modifiedAt`; a recent
write means recently active, not that a process is running. `--limit` is 1–100
per host (default 20). Hosts that fail are reported under `errors` instead of
failing the listing. `read` takes a ref or any unique prefix of its session id,
resolved among that host's 200 most recently written transcripts; older sessions
are not reachable by ref. It returns normalized, redacted messages and
tool calls plus an opaque `cursor`. Passing it back as `--after` returns only what
was appended. A cursor is bound to its session; `reset: true` means the transcript
was replaced and the page restarted from its tail, and `skippedBytes` means one
record was too large for a single read and was stepped over.

`/sessions` in the TUI takes the same arguments, or opens the saved sessions menu
with none. `clankie sessions` is also an alias for these CLI commands. Existing
`/agents` session arguments remain supported, but `/agents` without arguments
now opens the agents that are live, with offline agents that kept a thread behind
one "Past agents" entry. `clankie agents contacts` returns every known identity,
live or not, through the existing fleet API.

`clankie agents role NAME|PERSONA_ID ROLE|none` assigns an agent's team role
([ADR 0208](adr/0208-agents-carry-a-role-the-world-reads-it.md)). The built-ins
`planner`, `designer`, `builder`, `tester`, `reviewer` and `researcher` are
suggestions; a custom role is 1–24 letters, digits, spaces and hyphens. Quote a
role with spaces: `clankie agents role Smith "sound designer"`. The role is the
last argument and everything before it names the agent. A name must match
exactly one agent, case-insensitively; otherwise pass the persona id from
`agents contacts`. Roles are trimmed, inner whitespace collapses, and a built-in
in any casing is stored lowercase. A custom role keeps the casing you typed
and compares case-insensitively, so `Sound Designer` and `sound designer` are
one role. `none` clears it. It prints the updated persona.

`clankie agents roles` lists the built-ins (always, with counts), then custom
roles personas hold, most held first, each as `{ role, builtIn, count }`. Counts
include offline personas. The role is semantic, unlike the cosmetic
`appearance.accessory`, and persists with the persona across seats. The same
settings are the `set_persona_role` operator op (`{ personaId, role: ROLE |
null }`, steer grant), the `roles` op (read), and `hire_agent`'s and
`spawn_seat`'s optional `role`. In the TUI, `/agents role NAME "ROLE"` and
`/agents roles` honour quotes. The `/agents` picker shows each live agent's role.

The TUI separates `/chats` (personal/workspace chats with Clankie), `/agents`
(known identities), `/rooms` (group channels and Discord inspection), and
`/history` (all retained threads, including ongoing ones). `/conversation`,
`/conversations`, and `/chat` alias `/chats`; use `/history ID` for any retained
thread. See [product vocabulary](product-vocabulary.md).

`resume` continues a saved session as an ordinary hired seat in its native TUI.
It resolves fresh transcript metadata, reuses the exact live session when found,
or opens that session in Herdr. A remote resume needs an existing registered
Herdr fleet with the same SSH target and shell as the transcript source, plus a
grant for its recorded working directory; matching friendly ids alone are
insufficient. `--fleet` selects among several matching fleets. A local Codex
resume uses the original registered account that owns its transcript, rather
than choosing another account by headroom. The TUI's saved-session actions offer
**Resume in native TUI**.

An optional `--brief` is sent through native control when reusing a live seat;
an uncontrolled live seat must be messaged explicitly through its existing
lane. Incomplete fleet discovery refuses a new start. `delivery_unconfirmed`
or `start_unconfirmed` means inspect the named pane before retrying: it may
already have taken the work. A failed resumed start keeps its pane visible.
The inventory covers configured Herdr servers; it cannot prove that a separate
unregistered terminal is not holding the same history. Close that terminal before
resuming. A transcript's age is never used as proof of absence.

The operator API for saved sessions is
GET `/v1/agent-sessions?host=&limit=`, GET `/v1/agent-sessions/read?ref=&tail=|after=`,
POST `/v1/agent-sessions/resume` `{ ref, conversationId, fleet?, brief? }`, GET/POST `/v1/agent-hosts`,
and DELETE `/v1/agent-hosts/ID`. The resume route delegates to the existing
`spawn_seat` service operation. Both require an explicitly selected existing
operator conversation; inspection of a room is insufficient. Use
`clankie agents resume HOST:SESSION --conversation ID [--fleet ID] [--brief TEXT]`.
A missing `spawn_seat.conversationId` returns `not_ready` without launching.
Hired workers retain their original host-persisted owner through restart and
movement. Saved sessions without exact persisted ownership cannot be reclaimed
by inferring a persona or default conversation. Completion and escalation wake
only their owner, with current route grants checked again; there is no default
room or persona fallback.

It has no separate runner or run store. Clankie's own tools
are `agent_sessions` and `agent_session_read`, available where he has machine
access. `hire_agent` accepts `resume: "host:sessionId"` with the recorded harness
and workingDirectory; follow-ups use `message_seat`. Reading never starts or
resumes a harness. Workers retain their native identity and
ownership; a native resume does not enroll or replace them. Headless continuation
remains retired (ADR 0203).

### `herdr` / `herdr status [--json]` / `herdr use NAME`

Bare `clankie herdr` attaches the full workspace, as `clankie-herdr` does.
`herdr status` prints machine rows; `--json` includes those rows plus the configured and active
default-binding details. `herdr help` prints Clankie's commands.

The TUI `/status` shows the active fleet binding and `/herdr` shows both the
configured and active sessions. The binding is re-read at start, after `/herdr`,
and on `/status`. Routine fleet status stays out of the conversation footer.

In the TUI, `/herdr` opens a modal menu showing configured and active sessions.
Choose **Use an existing Herdr session** to pick a saved session (running ones
first), or **Create a session for Clankie** for a separate worker fleet.
Creating reuses Clankie’s own retained session if it already exists.
**Open active session** opens its viewer. After saving, choose **Restart now** to apply the binding
or **Later** to keep it pending. **Apply saved changes** restarts Clankie, relay
and Discord from the menu. Either restart then shows the binding he actually
landed on, and warns when the saved session did not answer. Existing Herdr panes
stay open. The same choices are available as `/herdr use NAME` and `/herdr create`.
The older `set --session NAME` and `set --runtime auto|bundled|external|disabled` forms
remain compatible for scripts; the TUI does not ask users to choose a runtime.

The binding is resolved at every service start and never written back
([ADR 0181](adr/0181-clankie-is-independent-of-his-connections.md)). He leads the
session or socket the owner explicitly named; failing that, his own private bundled Herdr
([ADR 0164](adr/0164-the-fleet-is-its-own-session.md)). A candidate that does
not answer is stepped over. If the owned runtime also cannot start, Clankie
continues with Herdr unavailable. A bound external session that stops stays
unavailable until restart; it never redirects existing work to a replacement fleet.

`clankie herdr disable` (also `/herdr disable`, or **Run without Herdr** in the
TUI menu) saves `runtime: disabled`. Apply with `clankie restart captain`.
Clankie starts without probing, downloading or starting Herdr. Conversations,
connected services and conversations remain available. Terminal actions
for that default fleet report unavailable. Named execution connections remain
independent; existing workers are not stopped.
Use `herdr use NAME` or `herdr create` and restart to enable execution again.

The invoking terminal's Herdr session never selects the fleet. `create` (the
compatible `set --runtime bundled` setting) selects the owned runtime directly. It follows official stable Herdr releases,
checking at startup and every six hours. Downloads must match the official
SHA-256 checksum. Updates are staged separately; active workers retain their
matching executable until their session ends. The next Clankie start without
a live fleet server uses the staged release. Existing sessions selected with
`use NAME` keep their owner's installation and update policy. `pnpm herdr:build`
prepares the pinned official offline fallback for a checkout. Panes in the bundled fleet start the owner's login shell with the
owner's environment: the private XDG roots that isolate that Herdr never
reach an agent, so `gh`, `git`, `mise` and the rest behave as in any terminal.
macOS permissions (screen recording, accessibility) follow the process that
started the service, so a fleet descending from a terminal carries that
terminal's grants; one started by the login-time autostart job may prompt for
them once. `set --session NAME` selects external mode and resolves that named
session on restart; `set --runtime external` keeps whichever session name is
already saved. External mode never starts or stops the owner's server.
`set --runtime auto` clears the named session and selects the bundled default. Apply changes with `clankie restart captain`.

`clankie herdr status --json` reports configured `herdr`, `settingsFile`, `restart`,
and the running service's `active` binding (or `unavailable`). Settings hold
the owner's intent and `active` holds what is live; the two differ whenever a
named session is down. The authenticated operator endpoint `GET /v1/herdr`
returns the running binding while it is available; pending
settings do not redirect clients. `/health` reports Herdr's state independently
of service liveness: disabled, unavailable or recovering execution does not make
the captain unhealthy. `/v1/herdr` returns 503 when no active binding is available.

`clankie-herdr` with no arguments is the shortcut for `clankie herdr open`. It
attaches a native viewer to the selected, already-running local server. With
arguments it is the fleet's own Herdr CLI: `status`, `set`, `use`, `create`, `disable`, and `open` stay
Clankie's, and every other verb is forwarded to the runtime he is bound to,
with its binary, its socket, and its configuration. So `clankie-herdr pane
list` reads the fleet, and `clankie-herdr server stop` ends a bundled fleet
that outlives the service (ADR 0164). Running a bare `herdr` instead reaches
whatever build is on PATH, which for a bundled fleet answers a protocol
mismatch on a socket it cannot see. Use **Ctrl+B, then Q**
to detach with the default bindings. Closing the viewer leaves Clankie and his
workers running. The TUI's `/herdr open` opens the same viewer and returns to
the conversation after detach. Native viewing requires a local service.

Every TUI reads the service's fleet, including from ordinary terminals and
unrelated Herdr sessions. `/jump`, clickable pane IDs, and the optional
herdr-lead `/board` commands target that fleet. Use the viewer to see a focused
worker. The optional board requires herdr-lead installed and linked in the
selected runtime. Pane-scoped messages and `clankie stance` carry the source
socket in `x-clankie-herdr-socket`: unrelated pane IDs cannot attach to or
change a worker with the same ID in another session.

### `herdr fleets` / `herdr add NAME --ssh HOST` / `herdr remove NAME` / `herdr prepare NAME`

A **machine** can expose one or more Herdr sessions, called fleets internally ([ADR 0184](adr/0184-clankie-leads-more-than-one-fleet.md)):
a named runtime connection whose transport is the owner's own ssh.

```sh
clankie herdr add pc --ssh volpe@supedupsilly --session default --shell powershell
clankie runtime workspaces pc --dir 'C:\src\rivals'
clankie herdr fleets
clankie herdr remove pc
```

`add` is `runtime connect NAME --ssh HOST --session SESSION [--shell posix|powershell]`.
`HOST` is a host or alias from the owner's ssh configuration; keys and host
trust stay there (`BatchMode`, so an unknown host key or a locked key fails
instead of prompting). `--shell powershell` is for a Windows host whose sshd
default shell is PowerShell. The session must already be running there: adding
checks `herdr --session SESSION api snapshot` over ssh and refuses otherwise.
`remove` unregisters the machine and its connections without stopping workers.
Use `runtime disconnect ID` to disable only one connection while keeping its identity.
Named machine connections reach the captain immediately; only default workspace changes require `clankie restart captain`.

`prepare NAME` readies that machine for Claude workers (VUH-1527), once per
machine; running it is the owner's approval. It ships this Clankie's own
`clankie-worker` plugin there as a `clankie` marketplace holding only the
worker (`~/.clankie/claude-plugin`), installs it disabled (each hire enables it
for its own session), and adds the worker channel to that machine's managed
policy (`C:\Program Files\ClaudeCode\managed-settings.json` on Windows),
keeping every entry already there. It also registers the same bridge for Codex
there, as a `clankie` MCP server in its config that inherits the pane's Herdr
identity, once. Policy is machine-wide, so the ssh account
must be that machine's administrator. Rerun it after an update to ship the
matching plugin. Its API is the operator-only
`POST /v1/runtime-connections/NAME/prepare`.

What crosses the link, and what cannot:

- Every call runs `herdr --session SESSION <verb> …` on the remote host with an
  exact argv (a Windows command line is built for `CommandLineToArgvW` and
  handed to `ProcessStartInfo`, so PowerShell never parses it). One multiplexed
  ssh connection per fleet carries them (`~/.clankie/ssh/%C`, `ControlPersist=600`).
- Only read and pane verbs pass: `agent list|get|read|wait|prompt|send-keys|start`,
  `pane list|get|read|send-text|send-keys|close|process-info|layout`,
  `tab|workspace create|list`, `api snapshot`, `session list`. Nothing that
  launches, attaches, stops, updates or reconfigures a server can be sent, and
  the Herdr CLI never starts a server for a subcommand. The remote server stays
  the one its owner started. Agent seats may run in a service session;
  desktop-bound work uses that machine's separately authorized desktop bridge.
- A remote pane's ids carry the fleet: `pc/w2:p1J`, `pc/term_…`. Local ids stay
  bare. The census Clankie reads lists each fleet under its own `HERDR FLEET`
  heading, and the roster carries remote seats with `fleet` set.
- He can watch (`herdr_watch pc/w2:p1J`), message and hire there
  (`hire_agent` with `fleet: "pc"` and a granted `workingDirectory`). A watch is
  persisted under its qualified id, so it resumes after a service restart.
  Remote panes are observed by polling one shared `pane list` every three
  seconds rather than holding a wait open per pane.
- A remote Codex hire gets the same native channel a local one does (VUH-1527).
  Clankie starts a dedicated `codex app-server` on that machine, detached and
  listening on its loopback only, reaches it through his own `ssh -L` forward,
  and the Codex TUI in the remote pane attaches to it with `--remote`. The
  brief, later messages and completion go through that server; nothing is
  typed into the pane. Its inherited Linear connectors are switched off from
  that machine's own Codex configuration. On Windows, launch arguments that
  `cmd.exe` would reinterpret are refused rather than altered.
- A remote Claude hire uses the `clankie-worker` plugin there, as a local one
  does: its brief and messages arrive on the plugin's channel and its hooks
  report each settled turn. Both travel over the fleet's **link**, which the
  service keeps up for every ssh fleet: an `ssh -R` forward from that machine's
  loopback to a listener here that answers only the fleet seat routes, and a
  token in `~/.clankie/link.json` there (owner-only) that reaches only that
  fleet's panes. The operator credential never leaves this Mac. Tracker
  isolation reads that machine's own `~/.claude.json`, and the launch settings
  are written there as a file. Until `herdr prepare` has run, a briefed remote
  Claude hire fails typed with the fix.
- Any agent in a pane on a linked machine (or on this Mac) can write to Clankie
  with the plugin's `message_clankie` tool, hired or not. It wakes him as that
  agent's output, not the owner's instruction; he answers with `message_seat`,
  which reaches a session that loaded `--channels plugin:clankie-worker@clankie`.
  Its receipt reports `stored` only after durable conversation acceptance.
  Both `mcp --seat` and `mcp --fleet` preserve an uncertain original across
  bridge/service replacement. Calling again reconciles that exact ID through
  a read; it never resends it. A different follow-up during reconciliation
  remains unsent. Missing or mismatched evidence stays blocked; do not delete
  the receipt files or switch bridges to bypass it. Older inbound writers
  without a delivery ID are rejected before dispatch.
- Other remote seats' replies are read with `herdr agent read`. Terminal
  observe/control is not wired for ssh fleets yet.
- An unreachable fleet is a state. `herdr fleets` (and `runtime list`) report
  `state: "unreachable"` with `lastSeenAt`; other fleets answer normally.

### `workdir [status]` / `workdir set PATH` / `workdir clear`

The captain's working directory — where his shell and sessions run when a
conversation names no workspace. Unset (the default) means the operator's
home directory. `set` expands a leading `~` and stores the absolute path.
JSON contains `workingDirectory` (the configured value or `null`),
`effective` (what the captain runs in after a restart), `settingsFile`, and
`"restart": "clankie restart captain"`.

### `reset --conversation ID`

Archive an idle service-owned global or workspace conversation and start fresh
model context under the same ID and title. For the root conversation:

```bash
clankie reset --conversation global-default
```

The TUI's `/reset` resets the selected conversation. `/clear` only clears the
screen; `/new` creates another conversation. Reset preserves persona, settings,
and durable memory, and clears the conversation's pending goals and watches.
The transcript and Pi session remain in `conversation-archives/reset-UUID`,
beside the service's `conversations` directory. JSON returns the fresh
`conversation` and `archiveId`.

Reset requires an idle conversation with no open side conversations. A root
bound to an external seat refuses reset: end that seat first because its
model context belongs to the external harness. The API's `reset` operation
requires `expectedRevision`; stale requests refuse without changing history.

<a id="conversation-commands"></a>

### `conversations list | show ID | tail ID`

Recent-history reads include native agent seats. Backward replay returns a
bounded window and an exclusive `previousCursor`; native cursors are opaque
identities, so pass them back unchanged when loading older messages.

Inspect the same conversations as the TUI picker, including Discord text/voice
rooms, operator chats, fleet agents, and channels. `conversation` is an alias.

```bash
clankie conversations list
clankie conversations show 1551975693582336060
clankie conversations show ROOM_ID --cursor 000000000100 --limit 100
clankie conversations tail ROOM_ID --cursor 000000000100
```

`list` returns JSON metadata. `show` returns metadata plus one replay page of
messages, tools, and lifecycle events; follow `nextCursor` while `hasMore` is
true. `tail` streams newline-delimited JSON events, live drafts, and explicit
cursor-recovery notices. `--limit` is 1–100 (default 100). A selector is a
conversation id, exact title, or an unambiguous Discord channel/target id.

Discord room records are read-only: use Discord to send messages. Their
transcripts include model-visible context and bounded, redacted tool details;
source-session entries identify the original local Pi journals for deeper
inspection. Voice rooms contain captain handoffs, not unrecorded ambient voice.
The existing authenticated conversation API provides these same list/get/replay/tail
operations. See [ADR 0176](adr/0176-every-room-is-an-inspectable-conversation.md).

### `send --conversation ID [--delivery steer|queue] [--attach PATH]... (MESSAGE | --stdin)`

Send to an existing operator conversation through the shared service API.
The default `steer` joins Clankie's active Pi turn at its next input boundary;
`queue` waits for a separate turn after earlier queued work. Either starts a
turn when idle. Channel rounds and external seats keep their own delivery
behavior ([ADR 0091](adr/0091-a-mid-turn-message-steers-the-turn.md)).

```bash
clankie send --conversation global-default "Focus on the failing test first"
clankie send --conversation global-default --delivery queue "Then update the docs"
cat notes.md | clankie send --conversation global-default --stdin
```

`--stdin` reads the message from standard input. Interior newlines are preserved;
surrounding whitespace is trimmed by the shared message schema. Passing both
`MESSAGE` and `--stdin` is refused.

The command reads the current revision, submits once, and prints the JSON
receipt including `runId`; it does not wait for a reply. Exit 0 means accepted.
A revision conflict or offline seat returns its JSON refusal and exit 1;
inspect the conversation before resubmitting. Observe replies with
`clankie --chat ID` or the conversation API. The running service and a local
captain credential are required.

`--attach PATH` (repeatable, at most eight) sends images or video with the
message: PNG, JPEG, HEIC/HEIF, GIF and WebP up to 20 MiB, and MP4 or MOV up to
200 MiB. The message may then be empty. Each file is uploaded through the
`upload_begin`, `upload_chunk` and `upload_commit` conversation ops in
512 KiB chunks and verified by SHA-256 before the send. Clankie sees images as
images and video as keyframes. A local agent seat receives copies under
`.clankie/inbox/<message>/` in its working directory (git-ignored by the
inbox's own `.gitignore`), with keyframes beside a video when ffmpeg is
installed, and a message listing their paths. An agent on
another machine cannot receive files: that send is refused as
`seat_undelivered` and nothing is delivered. See
[ADR 0209](adr/0209-owner-attachments-reach-agents-as-files.md).

```bash
clankie send --conversation global-default --attach ~/Desktop/bug.png "What is wrong here?"
clankie send --conversation CONVERSATION_ID --attach repro.mov --attach crash.heic
```

### `file publish --conversation ID PATH [--name FILE] [--type MEDIA_TYPE]`

Publish one finished regular file from the conversation's working directory.
`PATH` may be relative to that directory or an absolute path inside it. Realpath
containment rejects symlink and parent-directory escapes; files larger than
15 MiB are refused. `--name` changes only the safe delivered filename and
`--type` overrides extension-based content-type detection.

```bash
clankie file publish --conversation global-default build/report.pdf
clankie file publish --conversation global-default dist/site.zip --name launch-site.zip
```

The JSON result contains the opaque artifact id, filename, content type, byte
count, and SHA-256. The same metadata appears as a durable file event in the
conversation. The command is local-only because it accepts a host path; paired
devices may retrieve published bytes with their chat grant but cannot publish a
path on the Mac. Files share the conversation's retention and are removed when
that conversation resets, closes, or ages out. See
[ADR 0174](adr/0174-finished-files-belong-to-conversations.md).

### `prompt [--lane LANE] [--sections identity,persona,reach,fleet,address,model]`

The system prompt that lane's session starts from, printed verbatim as plain
text. The intended consumer is a seat launcher in another harness, which reads
it once at startup so the seat begins from the same words the service lanes do.

`LANE` is `operator` (the default), `discord_voice`, `discord_presence`, or
`gameplay`, and must be the lane the bearer speaks for. The operator bearer
comes from the credential broker, so this reads the operator lane.

Sections default to the five a session is built with, joined by one blank line:

| Section    | What it is                                                                                                                                                                                                 |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity` | `instructions.md` — who he is, his trust boundaries and where things live                                                                                                                                  |
| `persona`  | The owner-authored character configuration                                                                                                                                                                 |
| `reach`    | The machine-access or this-room paragraph for that lane; with machine access, the ready computer-use harnesses (`browser harnesses`) unless delegation is off; in Discord lanes, how a reply carries media |
| `fleet`    | Owner-authored routing preference; shell-holding lanes only, when set                                                                                                                                      |
| `address`  | His own mailbox, when one is connected                                                                                                                                                                     |
| `model`    | The card naming the model the service lanes run on (ask for it by name)                                                                                                                                    |

A seat that carries the identity some other way asks for the rest:
`clankie prompt --sections persona,reach,address`.

### `memory [status] | search <terms...> | retain|release|forget <episodeId> | correct <episodeId> --summary TEXT`

Inspect and curate episodes through the operator API. Output is JSON; success
exits 0 and failure exits 1. `status` shows retention usage and the newest 20
episodes, including private notes. `search` matches all supplied terms against
the note, source lane, and room, returning up to 20 newest matches and the total
matched count. Quote a correction's summary as one shell argument.

`retain` keeps an episode beyond the 128-entry recent ring; `release` returns it
to that ring and may immediately age out an old episode. The retained store
holds up to 1,024 episodes and refuses another retain when full. Release or
forget an episode before retrying; existing retained notes are never evicted
to make room. `correct` replaces the note while preserving its source and date.
`forget` deletes the episode from both recent and retained recall. `/memory`
exposes the same controls in the console. See [Memory](memory.md) for lane
privacy and migration behavior.

### `metrics [--run ID] [--limit N]`

Recent settled captain turns, newest first, from the durable
`~/.clankie/captain/turn-settled.jsonl` the service already appends. Reads
through the operator API (`GET /v1/captain/turn-metrics`), so the CLI and the
route answer the same rows. `--limit` is 1–100 and defaults to 20; `--run`
narrows to one run id.

Each item carries the turn's counters — outcome, per-tool counts, first mutating
tool, context occupancy — plus:

- `execution`: the `model`, `provider`, and `effort` that actually ran the turn,
  captured as it executed. A `/model` or `/effort` change under a live
  conversation belongs to the next turn to execute, not to the one in flight.
- `usage`: `totalTokens` summed over the assistant messages the provider
  reported for this turn, and `reports`, how many reports contributed.

Both are `null` when unknown, and unknown is said out loud rather than defaulted.
`execution` is null for turns settled before the capture existed or when the
session had no model bound; `usage` is null when nothing was reported — never
zero, which would read as a free turn. `contextTokensStart`/`contextTokensEnd`
are context occupancy, not usage and not a charge; no dollar figure is inferred
anywhere.

No transcript, tool argument, tool output, or credential appears in the output.

```json
{
  "ok": true,
  "items": [
    {
      "schemaVersion": 1,
      "type": "captain.turn.settled",
      "conversationId": "…",
      "lane": "operator",
      "runId": "…",
      "outcome": "completed",
      "toolCount": { "bash": 6, "read": 2 },
      "mutatingCount": 1,
      "contextTokensStart": 21000,
      "contextTokensEnd": 48000,
      "execution": { "model": "gpt-6-astra", "provider": "openai-codex", "effort": "high" },
      "usage": { "totalTokens": 41200, "reports": 3 }
    }
  ]
}
```

### `memory-card [--lane LANE] [--hook]`

The memory card that lane's next run injects, printed verbatim as plain text.
The intended consumer is a per-turn hook, so a seat in another harness carries
the same recent past his own sessions do.

`--hook` reads Claude hook JSON on stdin. On `UserPromptSubmit` it prints the
card only when that `session_id` has not seen this exact card yet, so unchanged
turns add nothing to the conversation. `SessionStart` prints nothing and re-arms
the session, so the prompt after startup, resume, `/clear`, or compaction
injects it again. Input without a usable `session_id` prints the card every
time.

Filtered by lane exactly as the session's own injection is: operator-private
episodes reach only the operator lane. Empty output means the lane has recalled
nothing yet, which is not an error.

### `telemetry ship --spool DIR --cursor FILE --log-group NAME [--once] [--interval SECONDS]`

Hosted infrastructure only. Ships a body's metadata telemetry spool (what
`CLANKIE_BODY_TELEMETRY_DIR` collects) to a CloudWatch Logs group, stream
`<tenantId>/<instanceId>`, each event at its own time. It must run on the EC2
host with instance metadata reachable, not inside the body: the tenant and
instance ids and the credentials come from the instance, never from the
spool. Every line is parsed against the event schema again before it leaves;
anything else is counted as `dropped`. The cursor file records how far each
spool file has shipped and advances only after CloudWatch accepts.

`--interval` is 10–3600 seconds (default 60). Without `--once` it runs until
`SIGTERM`, printing `{"ok":true,"shipped":N,"dropped":N,"files":N}` per pass
and `{"ok":false,"error":…}` on stderr when a pass fails; a failed pass is
retried from the same cursor. See [hosted bodies](../infra/hosted/README.md#body-telemetry).

<a id="skill-setup"></a>

### `skills [opinionated on|off | exclude NAME | include NAME]`

List the bundled skill catalog as JSON, with `class` (`product` or `opinionated`)
and `included` for each skill. `clankie doctor` includes the same selection.

```bash
clankie skills
clankie skills opinionated off
clankie skills opinionated on
clankie skills exclude reflect
clankie skills include reflect
```

`skills.opinionated` defaults to `true`; `skills.exclude` defaults to `[]`.
Product/tool and repo-authored skills always stay on; excluding one is refused.
`include` removes an exclusion and leaves the class switch unchanged. The console
has the same controls in `/skills` and `/setup` → Working skills.

Changes apply to new service sessions, local hires and Claude seats; existing
context is not erased. Reset a service conversation or start a fresh seat after
changing the selection, and reopen the console for its initial autocomplete.
No service restart is needed for selection changes once this code is running.

`hire_agent` accepts `skills: "bundled" | "plain"` for one local Claude, Pi or
Codex hire; omission follows the owner setting. `bundled` still honors exclusions.
The result records the condition and supplied names. Unsupported/remote routes
cannot honor an explicit override and refuse it. Independent global or project
skills can still be discovered by Claude/Codex; this switch does not rewrite
owner-global selection. See [the full bundle and A/B limits](bundled-skills.md).

Local briefed Codex hires use a dedicated app-server with a native Codex TUI in
Herdr. Briefs and `message_seat` use protocol receipts; completion comes from turn
events. The owner can type into the same session, whose identity and transcript
stay visible. Existing unmanaged seats can use a supported native queue or
channel. Automated messages never fall back to terminal typing. A `steered`
receipt means guidance reached the active Codex turn, not an after-turn queue.

A supplied `hire_agent` brief goes through the harness's own interface when a
seat adapter drives that harness locally ([ADR 0187](adr/0187-clankie-hires-his-own-seats.md),
VUH-1458). A Claude hire starts the real interactive TUI with the
`clankie-worker@clankie` plugin enabled for that session: the brief and later
`message_seat` messages arrive as channel notifications, a message counts as
delivered only once it appears whole in the native transcript, and the plugin's
Stop and StopFailure hooks settle `herdr_watch` with Claude's own final text.
The worker is never swapped for a headless process; the owner can type into its
pane at any time. This needs the owner's one-time consent: the plugin installed
and disabled, and its channel approved in managed settings (see the
[plugin README](../integrations/claude-plugin/README.md#worker-channel-plugin-clankie-worker)).
Until then the hire reports unavailable control with `consent_required` and the
owner's fix. It does not launch a second worker or type the brief into the pane.
Nothing accepts the development-channel warning on the owner's behalf.

Every hire logs its selected lane and reason. The result carries `control.mode`:
`channel` for the Claude worker channel, `adapter` for Codex, `terminal` for an
unbriefed native launch, or `unavailable` with `control.reason` explaining missing
structured control. Registered remote fleets do not change the control lane of a
local hire. Questions and folder-trust prompts remain visible owner decisions.

Failed startups log `hire_agent.startup_failed`, with its
session ID, resolved transcript path (null when no file is found), and rejecting
rule. Claude receipt failures also log `hire_agent.receipt_rejected`, distinguishing
`transcript_unavailable`, `no_new_operator_message`, `complete_body_mismatch`, and
`mailbox_not_delivered`, without logging the brief. A mailbox delivery alone is
not proof that Claude recorded it. Only the selected bridge polls: a globally
registered `clankie-seat` stays inactive when the worker plugin is selected.

An uncertain start or brief delivery retains its pane for inspection and reports
uncertainty. The turn may already have started; reconcile its native session before
retrying. `message_seat` distinguishes confirmed delivery, unconfirmed delivery,
and unavailable control. External Codex messages first try the selected machine's
existing app-server proxy. `state: steered` confirms the exact active turn;
`state: queued` and `status: queued_until_turn_end` mean native queue acceptance,
not that the agent saw the message. A goal may hold it until the whole goal ends.
No new setting or daemon is enabled. An unavailable connection does not promise an automatic
retry. The current Codex adapter's control map is in memory, so a saved session
reference alone does not reattach after a service restart. Sends target the bound
Codex thread even if the owner switches the TUI to another thread; they do not
follow terminal focus. Explicit owner terminal
control remains available; normal agent messages do not use it. See
[ADR 0207](adr/0207-work-records-and-native-agent-delivery.md).

<a id="seat-commands"></a>

### `claude[N]` and `seat [--harness claude|codex] [--resume] [--conversation ID] [--plugin-dir PATH] [--dry-run]`

Sit in Claude Code as Clankie ([ADR 0152](adr/0152-a-harness-takes-the-operator-seat.md)).
`clankie claude` opens this seat with `claude`; `clankie claude2` uses your
`claude2` account command. Numbered commands are resolved through your interactive
`$SHELL`, including shell aliases and functions. The same seat flags work with
either command. Each numbered command keeps its own resume record. `clankie seat` remains available, including its Codex harness.
Needs a TTY and the selected Claude command available. The launcher projects the bundled plugin
(or `--plugin-dir` source) into a private launch directory with only the selected
skills. Identity, hooks, and MCP are retained. It passes the permission allowlist
for `clankie` commands, disables an older installed `clankie@clankie` for this
session, and enables `clankie@inline` with the development channel flag for that
same identity. This also prevents a stale marketplace copy from restoring pruned
or disabled skills. Keep any marketplace seat plugin disabled globally, since
its forced output style makes every session answer as him when enabled there.
With `--conversation global-default`, inside the service's herdr fleet it names
that pane `clankie` once Claude Code
is detected there, which binds the pane to his own persona rather than a fleet
contact; a second pane claiming the name stays an ordinary fleet agent and is
told so on stderr. The pane is un-named again when the session ends.

Every fresh seat starts a new Claude Code session under a recorded id and creates
a separate workspace chat through `POST /v1/captain/seat-context`, rooted at the
launch directory. Multiple launches in the same directory or account each get
their own chat, transcript, tool context and wake channel. The chat is available
in the app and `clankie conversations list`. A running service and operator
credential are required; failure to create the chat stops the launch.
`--resume` reopens the last seat for that Claude command and its chat. The
conversation selection is retained on resume, and a different `--conversation` is refused.
Skill selection is reapplied at launch, but resumed history can still contain previously loaded guidance.
`--conversation ID` selects an existing global/workspace service conversation,
resolves its cwd through `/v1/captain/seat-context`, and opens Claude there. That
workspace must exist on the native host. The prompt includes its agent
instructions and the owner's persona/fleet preferences. The MCP bank and channel
share its conversation. Inherited worker capabilities and conversation
selections do not select the seat. Use `--conversation global-default` to select
the shared global chat. Workspace seats do not rename themselves as the global Herdr head.

`--dry-run` prints the launch plan without creating a chat or launching:

```json
{
  "ok": true,
  "command": "claude",
  "args": [
    "--name",
    "Clankie",
    "--settings",
    "{…}",
    "--plugin-dir",
    "…/skill-projections/launch-…",
    "--dangerously-load-development-channels",
    "plugin:clankie@inline",
    "--session-id",
    "…"
  ],
  "plugin": { "source": "plugin-dir", "path": "…/skill-projections/launch-…" },
  "channel": true,
  "sessionId": "…",
  "resumed": false,
  "cwd": "/Users/me/dev/project",
  "newConversation": {
    "op": "create",
    "schemaVersion": 1,
    "scope": { "kind": "workspace", "workspaceId": "/Users/me/dev/project" },
    "title": "Clankie claude · project · …"
  }
}
```

`plugin.source` is `plugin-dir`; the projected skill catalog is also in the plan.
The [plugin README](../integrations/claude-plugin/README.md) describes the component
source and session-only channel identity.

`--harness codex` opens the real Codex TUI on its own app-server thread.
Install the [Codex seat plugin](../integrations/codex-plugin/README.md) first.
The launch plan includes a typed `hook_trust_required` owner step: review the
plugin in Codex's `/hooks`, then exit and launch the seat again. The launcher never
bypasses hook trust. Wakes bind only after trusted session hooks succeed.
`--resume` retains the last Codex thread and conversation independently of the
Claude seat. Fresh Codex launches also create their own workspace chat.
Both harnesses use the same service prompt, memory card, tool bank,
redacted transcript endpoint and conversation outbox.

### `mcp [--lane operator] [--conversation ID]`

The seat's stdio side: an MCP server on stdin/stdout that re-serves the
service's lane tool bank (`/v1/mcp`), resolving the operator bearer from the
credential broker so no secret lands in a harness config. The plugin's
`.mcp.json` names it; a Codex MCP config names the same command. Only the
operator lane has a bearer on this side. stdout is the wire: progress goes to
stderr, and the process ends when the harness closes stdin. `--conversation ID`
or the launcher-set `CLANKIE_CONVERSATION_ID` binds tools, polls and replies to
one service conversation; the API rejects a changed binding within an MCP session.

It is also his channel. While it runs it long-polls `/v1/seat/events` and
pushes each self-wake, herdr completion watch, and room escalation into the
session as `<channel source="clankie" kind="wake|watch|escalation"
conversation="…" event_id="…">`; that polling is what binds the seat as his
head, and with no bridge polling the same turns run the pi operator lane. A
`reply` tool answers an escalation by `event_id`; the reply lands in the
escalating conversation as his own message. Claude Code loads the channel
only when `clankie seat` passes its development flag; without it the tools
still work without consuming events, leaving those turns with the service.

### `mcp --seat`

For connected-account tools in a worker, use `mcp --grant FILE` instead; see below.

A fleet pane's stdio MCP server: no tools, only the channel. A message to that
agent (a DM from the app, or a group-chat turn) arrives as
`<channel source="clankie" kind="message" conversation="…" event_id="…">`
instead of being typed into the pane. The bridge polls only when the parent
`claude` argv loaded `server:clankie-seat` as a channel; otherwise it serves
empty and does not bind. Claude Code binds that channel when the server is in
the harness MCP config (`claude mcp add -s user clankie-seat -- clankie mcp --seat`) and
the session is started with `--dangerously-load-development-channels
server:clankie-seat`. `--channels server:clankie-seat` starts without the
development-channels dialog but then rejects `server:` as not on the approved
allowlist. The service's hire path persists the server and passes the dangerous
flag for a claude seat.

### `mcp --fleet`: local owner-granted tools

Register `clankie mcp --fleet` in Codex with `env_vars = ["HERDR_PANE_ID",
"HERDR_SOCKET_PATH"]`, or install the `clankie-worker@clankie` Claude plugin.
Generated or symlinked Codex configuration belongs to its source manager: inspect
`doctor.harnessBridges.codex.configSource` and change that source, never append to
or replace the runtime symlink. Hired local Codex seats receive a launch-only
registration even when their selected account uses another `CODEX_HOME`.

On macOS, a separate loopback listener verifies the actual TCP client's process
against the live pane in Clankie's connected local Herdr session. The pane ID is
a hint, not a credential. Private hired Codex app-servers use the service's live
process-to-pane registry. Shared Codex daemon MCP processes cannot prove which
pane owns them: exit and restart the pane's Codex under the existing
`daemon_auto_start=false` configuration. Local process proof on other platforms
is not implemented; SSH fleet links keep their existing authentication.

The owner grants `default` through `clankie access fleet default linear --tool
get_issue` (repeat `--tool` for the needed tools); `clankie access list` inspects
those grants, and `clankie access revoke ID` revokes them immediately, including
on existing MCP sessions. Tools and argument restrictions are checked on every
call against the same connected account. Fleet grants are standing until revoked
as in VUH-1527; they are not short-lived bearer grants. MCP sessions expire after
15 minutes idle and reinitialize while membership and grants remain valid.
No bearer or provider credential is written to the local discovery file.

`doctor.harnessBridges` separates Claude installation/enabling, Codex registration
and its config source, shared-daemon ancestry, and the invoking process's live
local membership probe. A successful probe does not imply a grant exists. Run
`access list` to inspect owner grants. Installer output offers the explicit
harness registration commands; it never enables a plugin or grants tools itself.

### `access` and `mcp --grant FILE`

`clankie access linear [verify]` reads or verifies the connected account.
`access list`, `access issue REQUEST.json --out GRANT.json` and `access revoke ID`
manage individual worker grants. The private file feeds `clankie mcp --grant FILE`,
which serves only granted tools and loads no operator bearer or seat channel.
Tokens expire after at most 15 minutes and require explicit reissue.

`access fleet NAME SERVER [--tool NAME]...` grants agents in that Herdr session
connected tools through its fleet link until revoked, with no bearer delivery.
`/access` exposes status, verification and revocation; issue from the terminal.
See [worker access](worker-access.md) for restrictions and account bindings.

### `stance <working|thinking|stuck|hauling|resting> [--note TEXT] [--for SECONDS]`

For agents, not for people ([ADR 0148](adr/0148-an-agent-moves-its-own-figure.md)).
Say what you are doing with your own figure in the commons; the operator's app
poses it and moves it accordingly, and prints your note on your Messages row.

Takes no seat argument by design: the seat is resolved from `HERDR_PANE_ID` in
the caller's own environment against the live Herdr census, so this can only ever
move the figure the caller is sitting in. `--for` defaults to 15 minutes and is
capped at one hour — a stance is a live statement, and once it lapses the figure
goes back to being posed by what its pane is observed to be doing.

```json
{
  "outcome": "stated",
  "seatId": "…",
  "personaId": "…",
  "stance": { "pose": "stuck", "note": "waiting on the build", "statedAt": "…", "expiresAt": "…" }
}
```

`{"outcome":"unseated"}` means the pane holds no fleet seat — normal in a plain
shell pane, and not an error.

### `discord [status]`

Return stored and effective non-secret Discord configuration:

```json
{
  "ok": true,
  "discord": { "activeBody": "bot", "systemActorUserIds": ["12345"] },
  "effectiveDiscord": { "activeBody": "bot", "systemActorUserIds": ["12345"] },
  "overriddenByEnvironment": [],
  "settingsFile": "/Users/me/.config/clankie/settings.json",
  "restart": "clankie restart"
}
```

`discord` is the stored value. `effectiveDiscord` includes environment
overrides, whose variable names appear in `overriddenByEnvironment`.

### `discord transcripts [--cursor CURSOR] [--limit N]`

Read the private retained voice log through the authenticated service API.
The default page contains the newest 100 entries; `--limit` accepts 1–200.
Pass `nextCursor` to read later entries and follow `hasMore` when paging.
Logging must be enabled through `discord set --voice-transcript-logging-enabled on`
and activated by restarting the relevant services; otherwise the page is empty
with `enabled: false`. `/vt` shows the same entries in the console.

Human entries retain consented final recognition. Clankie's entries have
`role: assistant`, generated `text`, provider `itemId`, and playback outcomes
(`played`, `interrupted`, `suppressed`, `failed`, `truncated`). An interrupted
or failed reply may include words that never played: the exact audible word
cutoff is unknown. No raw audio is saved. See [ADR 0121](adr/0121-development-voice-transcripts-are-explicit.md).

### `discord set --field value […]` / `discord clear --field […]`

Set several fields atomically, or reset fields to their schema defaults.
Field flags are the `settings.json` camel-case names in kebab-case. Lists are
comma-separated (`none` clears); booleans accept `on|off`, `true|false`, or
`enabled|disabled`; integer fields require whole numbers. Zod validates the
completed settings document and the settings writer rejects token-shaped
values.

| Group                  | Fields                                                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application and roles  | `application-id`, `guild-id`, `swarm-guild-id`, `ambient-role-ids`, `ambient-user-ids`, `approval-role-ids`, `owner-user-id`                                                                                          |
| Machine grants         | `system-actor-user-ids`, `system-actor-guild-ids`, `system-actor-channel-ids`                                                                                                                                         |
| Text and presence      | `text-ingress-enabled`, `ingress-guild-ids`, `ingress-channel-ids`, `ingress-dm-policy`, `ingress-dm-user-ids`, `ingress-context-messages`, `tool-progress-channel-ids`, `presence-guild-ids`, `presence-channel-ids` |
| Voice                  | `voice-enabled`, `voice-guild-ids`, `voice-channel-ids`, `voice-channel-id`, `voice-join-policy`, `voice-consent-policy`, `voice-transcript-logging-enabled`                                                          |
| Body selection and lab | `active-body`, `user-session-enabled`, `user-session-guild-ids`, `user-session-channel-ids`, `user-session-voice-enabled`, `user-session-voice-channel-ids`, `user-session-dm-policy`, `user-session-dm-user-ids`     |
| Activity               | `activity-application-id-gba`, `activity-tunnel-name`, `activity-tunnel-hostname`                                                                                                                                     |

`active-body` is `bot` or `user_session`. These commands never accept Discord
tokens and do not perform the lab-user ToS opt-in. The TUI `/discord` modal uses
this writer for non-secret fields; its existing secret and opt-in flows stay on
the credential broker and service HTTP catalog.

### External native agent chats

Herdr discovery provides agent identity, routing and status. It does not import
external conversations or create chat threads. Opening a persona chat and using
the existing `replay`/`tail` operations reads the harness session on demand,
including messages, tools, typing state and contained images. Native cursors are
opaque; clients follow the returned recovery cursor after a session or history
change. The host persists the source locator, not a second native transcript.
Explicit app sends and native messages remain durable host communications.
Clankie can inspect panes and arm completion watches independently of chat views.
See [the native chat decision](adr/0188-native-agent-chats-read-their-own-history.md).

<a id="evaluation-commands"></a>

### Independent evaluator

```sh
clankie evaluator enable --harness codex
clankie evaluator enable --harness claude
clankie evaluator status
clankie evaluator open
clankie evaluator disable
clankie evaluator retry EVALUATION_UUID
```

The local operator credential authorizes `GET /v1/captain/evaluator` and
`POST /v1/captain/evaluator`. POST accepts `{ "action": "enable", "harness": "codex" }`,
`disable`, `open`, or `{ "action": "retry", "id": "<UUID>" }`; an omitted harness
preserves the selection. In the TUI, bare `/evaluator` opens a menu that toggles
the evaluator, switches its harness, opens its pane, shows recent assessments,
and retries failed jobs; `/evaluator` also accepts the same arguments and renders
the queue, recent assessments, linked issues/MRs and errors. `open`
focuses the evaluator in the service's active Herdr session.

CLI success is `{ ok: true, evaluator: ... }`, with exit 0; transport, authentication
or command errors exit 1. Invalid API commands return 400, missing operator
authority 401/503, and conflicting commands 409. The status includes `enabled`,
`harness`, evidence `directory`, optional `paneId` and `error`, `queued`, and up to
50 recent `jobs`. An enabled evaluator can report an operational error (missing
harness, blocked startup, unavailable Herdr); inspect `error` and the pane.

The evaluator is a developer diagnostic, not a user feature. It defaults off and
captures only Clankie’s Pi turns and native head-seat replies while enabled; the
console footer shows `evaluator on · HARNESS` for as long as it is. Other Herdr agents do not trigger assessments.
Enabling creates its own pane and starts a harness;
new work uses fresh agent context. Captures coalesce for a quiet minute, with
fifteen-minute checkpoints for continuing activity. Only a schema-valid report
from a settled agent completes an assessment. Restart resumes inspection of the
existing assignment; uncertain failures block every retry until the original delivery is reconciled. A busy evaluator
pane keeps new work queued rather than failing it. The pane is recognized by its
Herdr name, or by its terminal plus harness session or process once a harness
clears that name; a pane it can no longer prove is its own is left open and a
fresh one is started. The service
interrupts assessments after thirty minutes. Disable stops new capture and
dispatch; in-flight work finishes. It does not change Linear following, merge
changes or close review panes.

Evidence and queue state live under `~/.clankie/captain/evaluator/`, outside
conversation pruning. Goal identity groups continuations; otherwise captures
are conversation checkpoints and do not assert a completed task. Pi transcript
excerpts are bounded to 512 KiB and declare truncation; native projections retain
their existing bounded entries. Gameplay journals are not separate triggers.
Raw evidence remains local; findings carry redacted excerpts to Linear. See
[the evaluator decision](adr/0178-the-evaluator-has-its-own-seat.md) for scope and limits.

### Hired seat lifecycle hooks

`clankie seat-hook` is the `clankie-worker` plugin's hook (VUH-1458). Inside a
pane Clankie hired (`HERDR_PANE_ID` set), it reads
Claude's `SessionStart`, `UserPromptSubmit`, `Stop` or `StopFailure` JSON on
stdin and posts `{ event, sessionId, lastMessage?, error? }` to
`/v1/fleet/seats/{paneId}/hook` with the operator credential. The final text is
the hook's `last_assistant_message`, or the transcript's last reply when the hook
omits it. The service records it only when herdr reports that Claude session in
that pane; anywhere else the command does nothing.

### Native seat transcript sync

`clankie seat-sync` consumes Claude or Codex hook JSON on stdin. The `clankie seat` launcher
sets `CLANKIE_SEAT_SESSION_ID` and its selected `CLANKIE_CONVERSATION_ID`; unlaunched
plugin use and hooks for another session are ignored. The plugin invokes sync at
session start/end, prompt submission, stop/failure and before compaction.

The CLI reads the matching native transcript locally, redacts display records,
and posts bounded message/tool batches to `/v1/seat/transcript` with the operator
credential. No host file path is read by the service. The session is pinned to its
conversation; retries and resume retain the same native entry identities. The
next hook retries retained records after a transport failure. The final page carries
`responding` at prompt submission and `waiting` at session start/end or stop/failure;
compaction leaves activity unchanged. Empty transcripts still carry lifecycle
activity. These are display signals, not service-run completion or ownership. Reset retires that
conversation's native sessions; launch a new seat afterward so old history cannot
repopulate the cleared conversation. Sync failures never
instruct the harness to continue or block a stop. The current 9,000-entry display tail
is the replay bound. Image files use `clankie file publish` separately.

## Services

| Name on the CLI | Process                              | Aliases                                                                |
| --------------- | ------------------------------------ | ---------------------------------------------------------------------- |
| `all`           | every service, in order              | (default)                                                              |
| `clankie`       | captain + HTTP API on :4310          | `captain`, `captain-eve`, `eve`, `control-plane`, `controlplane`, `cp` |
| `relay`         | remote operator relay                | `app-relay`, `phone`                                                   |
| `discord`       | official bot                         | `discord-bridge`, `bridge`                                             |
| `user-session`  | personal-lab Discord body            | `discord-user-session`, `lab`                                          |
| `activity`      | watch-me-play surface                | `watch`, `viewer`                                                      |
| `tunnel`        | cloudflared in front of the activity | `cloudflared`                                                          |
| `awake`         | owner's keep-awake (`caffeinate -s`) | `keep-awake`, `caffeinate`                                             |

Unknown names fail closed without signalling any process.

## Environment

| Variable                    | Role                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `CLANKIE_CONTROL_PLANE_URL` | Service origin for probes, pairing, devices, play. Default `http://127.0.0.1:4310`.                                       |
| `CLANKIE_CAPTAIN_URL`       | Compatibility alias for the same origin.                                                                                  |
| `CLANKIE_OPERATOR_TOKEN`    | Test/CI override for the operator bearer. An env/store mismatch makes `health` fail. Remove it before rotating.           |
| `CLANKIE_LAUNCHER_PATH`     | Path used to spawn a deferred self-restart; `autostart enable` records it as the login agent's program.                   |
| `XDG_CONFIG_HOME`           | Config root. Model/provider config is `$XDG_CONFIG_HOME/clankie/clankie.json` (default `~/.config/clankie/clankie.json`). |
| `XDG_STATE_HOME`            | Process records and logs (`$XDG_STATE_HOME/clankie/`).                                                                    |

## Console-only, not missing

These carry secrets, external consent, or live session chrome, so entry stays
interactive in the console. The capability exists — only the flag does not:

- `/setup` — first-run sign-in and model choice, then a checklist that opens
  the other wizards; `doctor`'s `captain` field is its headless readiness
- `/auth` and `/connect` secret entry — provider keys, OAuth, Linear (MCP token
  and webhook signing secret), and email
- `/discord` secret entry and lab-user ToS opt-in — Discord tokens never become flags
- `/voice` — realtime/TTS provider and brokered credentials
- `/btw`, `/board`, `/jump`, `/conversation`, `/goal`, `/layout` — live console state

There is no `clankie start`, `clankie up`, or `clankie auth`. Local model
servers are not supervised.

### Where a provider key lives

`/auth anthropic` opens API-key entry directly. Clankie no longer offers Claude
subscription login or refresh; replace any legacy token with an Anthropic API
key (or remove it through `/auth`). Doctor/setup do not count that legacy OAuth
entry as usable authentication. Native Claude Code and Codex retain their own
login.

Hosted Clankie/Pi refuses ChatGPT subscription login and token forwarding pending
OpenAI approval, before opening a browser or requesting a device code. Use a
provider API key or included model usage. Local/self-hosted ChatGPT login remains
available. Approval and waitlist submission are owner actions; see
[ADR 0052](adr/0052-subscription-precedence-over-metered-api-key.md).

One credential store backs both surfaces: `/auth <providerId>` writes it, and
every service this CLI starts reads it. Provider config in `clankie.json` never
holds a secret — the schema rejects secret-shaped keys — so an endpoint that
wants a bearer gets it from the store, keyed by the same provider id as the
model ref.

A local endpoint that checks a key therefore needs two things, not one:

```sh
clankie model add-local --id ds4 --base-url http://127.0.0.1:8000 --models <id>
# then, in the console: /auth ds4
```

`--models` is required there because the add-local probe is unauthenticated: a
keyed endpoint answers its `GET {baseURL}/models` with 401 and the probe
reports `Could not list models`. A genuinely keyless local runtime needs no
`/auth` step — it is served a placeholder bearer it ignores.

### Pointing the captain at a local model

Start to finish, with the runtime already serving:

```sh
curl -s -H "authorization: Bearer $KEY" http://127.0.0.1:8000/v1/models   # the real ids
clankie model add-local --id ds4 --base-url http://127.0.0.1:8000 --models <id>
# console: /auth ds4              (only if the endpoint checks a key)
clankie model set ds4/<id>
clankie restart captain
```

Model ids come from the endpoint, never from a guess: a runtime that serves
from a directory names the model after that directory, so `ds4/deepseek-v4-flash`
is a 404 where the served id is `DeepSeek-V4-Flash-0731-2.4bit-mixed`.

Two things decide whether a local captain is usable, and neither shows up in
`clankie doctor`:

- **Decode speed.** A large model whose weights get paged out runs one or two
  tokens a second regardless of the hardware's rating. Check `sysctl
vm.swapusage` on the host before blaming the captain.
- **Prefill.** Every turn re-sends the system prompt and the tool schemas, so
  time-to-first-token at 8k-32k context is paid on each one, not once. A model
  that chats acceptably can still be unusable in a tool loop.

Revert with `clankie model set <provider>/<model>` and another
`clankie restart captain`; nothing about the switch is one-way.

## Related

- [Operator console](../apps/tui/README.md) — TUI, workspaces, slash commands
- [Distribution](distribution.md) — install layout and `clankie doctor` on a release
- [Credentials](credentials.md) — bot vs user vs internal tokens
- [Architecture canonical homes](architecture.md#canonical-homes)

Managed pi workers use OpenRouter `moonshotai/kimi-k3`; the runtime harness selector chooses that explicit model instead of inheriting pi’s personal default.

## Local and hosted connection modes

A fresh `clankie` launch offers **This Mac** or a hosted connection before starting
a service. Existing installations remain local. Hosted startup never starts a
local body. Its footer identifies **Hosted · <machine>** and reports Connected,
Asleep/Waking, Sign-in expired, Access revoked, or Unavailable.

```sh
clankie login
clankie login --email you@example.com --code-stdin
clankie whoami
clankie conversations list
clankie --chat global-default
clankie logout
```

`login` is the one account sign-in (email code). If the account has a hosted
Clankie it lists the account's hosted machines and pairs a revocable device;
otherwise it signs **this Mac** in for remote access, which is also how a
signed-out Mac signs back in (restart the captain afterwards; the JSON output
says so). `connect hosted` asks for a hosted body specifically, so an account
without one gets an explanation instead of a doorway. `logout` only forgets the
hosted client; on a Mac that is not a hosted client it changes nothing and
points at `clankie remote-access off`. The current fleet model permits one machine per
account, so it is selected automatically. The list contract supports a picker
if that changes; headless selection uses `--machine ID`. `--url ORIGIN` selects
a compatible deployment (HTTPS, or loopback HTTP for development). Account
credentials exist only during login; the broker retains the device session,
encryption material and a separate device wake key. `whoami` shows the selected
machine and checks access without revealing secrets. `connect hosted` and
`disconnect` remain aliases for `login` and `logout`.

`/connection`, `/settings` and local `/setup` expose the mode choice. Reopen the
console after changing modes. Hosted `/conversation [ID]` selects a retained
thread; `/reconnect` retries the saved selection. `/persona`, `/model set
provider/model`, `/keys [PROVIDER]` and `/connect github|linear` change the
hosted body. `/fleet` and `/terminal` show its fleet and terminal catalog.

Headless `conversations`, `send`, `model`, `persona`, `accounts`, `fleet`,
`terminal` and `keys` address the selected machine. `keys set PROVIDER
--key-stdin` accepts a secret only on stdin. `fleet spawn|move|close --json-stdin`
and `terminal tail|control|input --json-stdin` accept the corresponding protocol
request fields from stdin; the verb fixes the operation. Terminal input keeps
the existing exclusive-control lease validation. Unknown operations fail closed.

The single hosted-device authority policy allows chat, fleet, terminal, model,
keys, persona and connections. **Restart, reset and deprovision require the
account page/control plane**, including when attempted through the old device
relay. The API policy does not inspect shell commands typed under terminal
control. Local lifecycle, autostart, sockets, `seat`, `mcp` and shell escapes
refuse in hosted mode.

Closing the client leaves accepted work running. `logout` forgets this Mac's
device credential and wake key and selects This Mac for the next launch;
account-side device revocation invalidates a lost Mac. Expired or revoked
access requires `login`. After pairing, an asleep host is woken using the app's
device-signed P-256 challenge protocol; status shows the wait and wake failures.
First login can wake the selected machine using the signed-in account. A legacy
body without wake registration needs account-page wake and a fresh login.
There is no local fallback.

`/remote-access` means **Remote access for this Mac**, for self-hosted use only;
`/gateway` remains its alias. When the Mac is signed out, its menu opens on
**Sign this Mac back in** (email + one-time code) and its status text starts with
that step; the same menu reads **Sign this Mac in to enable remote access** before
first setup. Headless: `clankie remote-access [status]`, `on [--email EMAIL
--code-stdin]` (the same sign-in as `login`, pinned to this Mac), `off`, `rotate-key`
and `direct --control-plane-url URL --relay-url URL`; `gateway` and the older
`disable` / `rotate-encryption-key` spellings still work.

`clankie status` also carries what `whoami` reports (`connection`), the live
`doorway`, and one `nextStep` line for phone access; `clankie doctor` carries the
same `nextStep`. `whoami` keeps working. In the console, `/login` is the account
sign-in (it skips the `/remote-access` menu; the model-provider `/auth` no longer
answers to `/login`), `/pair` adds a sign-in note when a code lacks the gateway
route because remote access is signed out, and `/devices` lists or revokes
paired devices and opens an empty list on `/pair`.

`clankie pair` never prints a code the doorway cannot carry. When the service
refuses an offer because remote access is signed out, it exits 1 with "No pairing
code was made" and names `/remote-access` → **Sign this Mac back in** as the fix
(JSON `status: "unavailable"`, same text in `error`).
It detects an existing hosted tenant and offers connection instead of creating
another doorway. Matching fleet, body and relay deployments plus a real
Mac/phone rehearsal remain separate from source verification.

## Bundled working skills

Clankie's seats include his process and leadership skill bundle. Local hired
Claude, Codex and Pi workers receive it through their launch configuration; a
plain harness keeps the owner's independent global selection. See
[bundled working skills](bundled-skills.md) for the inventory, source revisions,
per-harness mechanisms, deployment gate and remote limitations.

### Current agent assignment

From a local Herdr agent pane, `clankie work-on "Objective"` states what that
native session is working on. Add `--repo REPO_ID --issue ISSUE_ID` to link an
existing Work item, or run `clankie work-on clear` to remove the assignment.
Repo IDs come from `clankie work repos`. The authenticated `state_work` dispatch
resolves the caller's pane in its source Herdr session; devices cannot submit it.
Assignments persist across service restarts and follow the same native session
between panes. They do not change tracker status or ownership. The fleet also
projects local Codex goals from its native goal store and Clankie's conversation
goals. Native goal state remains separate from turn activity.

### OpenCode operator seat

`clankie seat --harness opencode --conversation ID --dry-run` reviews the native
launch, installed version, skill selection and required owner steps. Remove
`--dry-run` to launch; `--resume` uses the exact recorded session and chat.
Without `--conversation ID`, each fresh launch creates a separate workspace
chat; dry-run creates none. `/seat opencode`
in the console reviews the same plan. Installation, per-launch settings,
removal, native delivery semantics and current verification limits are in the
[OpenCode seat guide](../integrations/opencode-plugin/README.md).

### Delivery receipt stages

Delivery results add `deliveryStage` while retaining native outcome, queue state,
and detail. `stored` means service retention; `delivered` means the bridge has
acknowledged it; `consumed` means native queue/turn acceptance; `responded` means
a correlated reply or turn outcome, including silence. A native queue is
consumed even while waiting for the current turn or goal. None of these receipts
proves the model read the message or that requested work succeeded.

`unavailable`, `uncertain`, `expired`, and `rejected` are distinct stops. Every
retry of an uncertain delivery is blocked until its original receipt is
reconciled, including explicit retries and retries after service or launcher
restart. An exact late bridge acknowledgment or original-session native
transcript receipt can reconcile it without dispatching a replacement. Missing
or corrupt evidence remains blocked; changing channels is not a repair.
