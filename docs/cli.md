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

## Browser access to a self-hosted service

```bash
clankie http show
clankie http allow-origins https://app.example.test http://localhost:8086
clankie http allow-origins
```

`allow-origins` replaces `http.allowedOrigins`; the final example clears it.
Use the app's actual serialized HTTP(S) origin, including its non-default
port, with no path or trailing slash. The default list is empty. Wildcards,
opaque `null` origins, embedded credentials and duplicate origins are refused.

Both core and relay read the same saved list without restarting. The CLI
uses owner-authenticated `GET`/`POST /v1/operator/http-settings`: GET returns
`{schemaVersion:1, revision, http:{allowedOrigins}}`; POST takes
`{schemaVersion:1, expectedRevision, allowedOrigins}`. A conflict requires a
fresh read and reviewed change. Current terminal-control devices may use the
same settings API through their relay. No credential or pairing capability is
created by this setting.

On `/v1/*` and `/operator/v1/*` (including Work dispatch and tail), allowed
browser origins receive an exact allow-origin header and
`Vary: Origin`, including authentication errors. Refused origins fail before
route effects. OPTIONS preflight returns 204 only for an allowed origin,
supported requested method and explicit application request headers; it does
not authenticate or redeem a code. The LAN device doorway still exposes only
its existing device operations. No wildcard or credentialed-cookie CORS is
enabled. Native bearer authentication, one-time pairing, HTTPS/mixed-content
and browser local-network permission checks remain in force
([ADR 0274](adr/0274-self-hosted-browser-access-uses-exact-origins.md)).

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
The console opens on a blank page with the latest messages just above it;
scrolling up loads older retained history in pages without moving the text you are reading. Live messages continue
to arrive while older history loads. This applies to local and hosted consoles.
An unknown command exits 1 without starting anything. Common near-misses name
the real command: `clankie up` suggests `clankie start`.

## Lead-skin data tools

`clankie skin sample IMAGE OPTIONS.json --out NEW_DIRECTORY` samples a reference
onto its native grid. Options select the pitch/origin/grid, palette size or an
approved palette and edge-connected background cleanup. An automatic pitch is
reported as an estimate and can be corrected explicitly; tall bodies are never
squashed into a shorter cell.

`clankie skin compile SOURCE --out NEW_DIRECTORY` compiles text grids into
`manifest.json`, `lead.png`, paginated `review-N.png` sheets and `artifact.json`
with digests and review metadata. `clankie skin check DIRECTORY` mechanically
validates the complete pack against those local digests. Both return JSON and
reject malformed geometry, timing, coverage, bytes or digests. Existing output
directories are refused.

These local commands work without a running service, sibling app or art editor.
They make no generation request and do not change the live look. Local hashes
prove consistency, not catalog authorization. Owner key-pose approval must precede
animation; independent visual review must precede publication. See the
[shared compiler contract](../packages/lead-skin/README.md) for the data format,
limits and runtime verification API.

`clankie skin draft` uses the owner-authenticated service for durable briefs,
native rest/work/comms poses and exact-revision owner approval. Use `create
SENTENCE [--request UUID]`, `list`, `get ID [--version N]`, `pose COMMAND.json`,
`revise ID REVISION SENTENCE`, `generate ID REVISION --request UUID`, or
`approve|decline|cancel ID REVISION`.
See [owner key-pose drafts](skin-drafts.md) for owned attachments, sampling,
preview routes, approval provenance and cancellation. Generation retains a
restart-safe media journal, but paid requests refuse until the owner credit
policy exists. Uncertain provider work is never replayed. Draft operations
leave the live look unchanged.

## Conventions

| Rule                            | What it means                                                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| One JSON document on stdout     | Agents parse stdout. Progress and human narration go to stderr.                                                                        |
| Exit 0 or 1                     | 0 is success. 1 is failure. `doctor` inspection exits 0 — `ok` means the card was produced; explicit setup actions can fail.           |
| Secrets never as flags          | No API keys, Discord tokens, or operator bearers on the command line. `/auth` and `/discord` in the console, or the credential broker. |
| Fail closed, secret-free errors | Failure messages never echo tokens, pairing codes, or response bodies.                                                                 |
| Host                            | `CLANKIE_CONTROL_PLANE_URL` (default `http://127.0.0.1:4310`). `CLANKIE_CAPTAIN_URL` is a compatibility alias.                         |

`--json` is required only where the default is human-readable (pairing QR,
device and machine tables, credential-rotate sentence). Everything else is already JSON.

| Command                                                                                                                       | stdout                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `doctor [--machine NAME]`                                                                                                     | Human summary; `--json` preserves the full card                                              |
| `health`, `status`, `start`, `stop`, `restart`, `recover`, `autostart …`, `awake`                                             | JSON                                                                                         |
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
| `pair`, `devices`, `machines`, `herdr status`, `operator-credential rotate`, `protect`                                        | Human text; pass `--json`                                                                    |
| `help`                                                                                                                        | This index (plain text)                                                                      |
| `--version`                                                                                                                   | `clankie <version>`                                                                          |

Do not edit `~/.config/clankie/clankie.json`,
`~/.config/clankie/settings.json`, or Keychain entries by hand.

Fleet settings, persona, voice, Discord fields, worker-account holds, Linear
follow/wake and host availability use the owner settings API. The command reads
the current snapshot, sends its `expectedRevision`, and reports a conflict
without retrying or writing a local fallback. The TUI uses the same path. Start
the service and authenticate as its owner before changing these settings.

`GET`/`POST /v1/operator/host-settings` carries `host {keepAwake, autoUpdate}`,
its revision and support/managed-state metadata. Writes use
`{schemaVersion: 1, expectedRevision, changes: {keepAwake?, autoUpdate?}}`.
Keep-awake is supported only on a self-hosted Mac; managed hosting keeps automatic
updates enabled. These routes, voice, account holds and Linear follow/wake are
forwarded to devices with current Take Control authority.

`awake --local-setup on|off` explicitly prepares this Mac when the service is
down and refuses a remote transport. `update auto` has no offline fallback.
If runtime application of a saved host setting fails, the API returns 503 with
`saved: true` and `settings`; read GET to reconcile before another edit.

Local setup remains available for machine wiring before the service runs
(autostart, working directory, execution connections), account profile/home
registration and the signed Linear webhook URL (`linear webhook set/clear`).
Provider credentials remain in the broker. These are setup operations, not a
fallback after an owner API error. See [ADR 0248](adr/0248-owner-settings-use-one-revision-fenced-api.md).

## Command index

| Task                                                   | Commands                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| [Control Activity shares](#activity-shares)            | `share list`, `share request JSON`                          |
| [Diagnose the installation](#diagnostics)              | `health`, `status`, `doctor`                                |
| [Manage service lifecycle](#service-lifecycle)         | `start`, `stop`, `restart`, `recover`, `autostart`, `awake` |
| [Pair and manage devices](#device-setup)               | `pair`, `devices`, `gateway`                                |
| [Connect accounts and track work](#account-setup)      | `accounts`, `work`, `evidence`                              |
| [Build live views](#views)                             | `view`                                                      |
| [List shipped skills](#skill-setup)                    | `skills`                                                    |
| [Choose models](#model-setup)                          | `model`, `effort`, `image-model`, `video-model`             |
| [Connect machines](#runtime-setup)                     | `machines`, `connections`, `runtime`, `agents`, `herdr`     |
| [Move Clankie to another body](#transfer)              | `transfer`                                                  |
| [Read and send conversations](#conversation-commands)  | `conversations`, `send`, `file`, `memory`                   |
| [Use native seats and delegated tools](#seat-commands) | `claude`, `codex`, `mcp`, `access`                          |
| [Evaluate agent work](#evaluation-commands)            | `evaluator`                                                 |

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

`presence.currentActivity`, when available to the operator, contains a stable
`id`, `source` (`chat`, `discord`, `issue`, `coding`, `call`), redacted full
`text`, and a typed `target`. The status read opts in to the existing presence
request with `includeCurrentActivity: true`; Take Control owner devices use the
same contract. Support devices and non-owner bearers cannot opt in. Ordinary
presence fields and labels stay unchanged. Missing activity means the host has
no safe live event to show, not a guessed idle task. A settled tool/turn or a
released call clears its glimpse. A pending owner question instead shows its
full redacted prompt and its own thread target, and disappears once answered or
cancelled. The same presence read supplies it; no new poller is added. Older hosts
retain their ordinary presence
through the compatibility retry. See [ADR 0294](adr/0294-owner-activity-glimpses-follow-live-presence.md).

Service ids appear in dependency order: `clankie`, `relay`, `discord-bridge`,
`discord-user-session`, `activity`, `tunnel`, `awake`. `awake` is the
keep-awake ([`awake`](#awake)), on by default on a self-hosted Mac; it reads
healthy and "off" when the owner chose to let the Mac sleep.

`status` and `doctor --json` include `runtimeHealth` when the service exposes it:
process CPU percentage, `/health` latency, fixed CPU/health reasons, alarm state,
delivery state, and the last incident duration. `/status` and `/doctor` show the
same observation. Missing observations remain unknown.

### `runtime-health`

`clankie runtime-health status` reads the live observation and settings from the
owner API, `GET /v1/operator/runtime-health`. `on` and `off` enable or disable
alarms. Change any subset with `set`:

```sh
clankie runtime-health set --cpu-percent 50 --health-ms 1000 --sustained-seconds 300 \
  --sample-seconds 15 --cooldown-seconds 1800
```

These are the defaults. `/runtime-health` opens the TUI menu for every setting.
Changes use revision-guarded `POST /v1/operator/runtime-health` and apply on the
next sample without a restart. CPU is this service process's consumed CPU time
divided by elapsed wall time (100% is one fully busy core), rather than machine
load. A failed or timed-out health response also counts as slow health.
Health probes use a fresh local HTTP connection and time the complete bounded
response, so an idle shared fetch connection does not inflate the measurement.

CPU above its threshold or slow health must persist for the sustained duration
before one alert goes to the owner's default conversation (`global-default`).
The alert and its recovery, with the incident duration, are first recorded in
that conversation as received context, so every console and app surface shows
them even when no native seat can take a delivery. The same incident's text is
recorded once. They are then delivered to the conversation's native seat.
`status` reports both: `delivery` is the seat delivery, and `recorded` is the
conversation record. A persistent incident emits no repeated alert; the
cooldown bounds alarms for subsequent incidents. An unavailable native delivery
retries the same text at most once a minute, and a retained uncertain native
receipt counts as accepted so it is not replayed. These observations create no
service model turn. Include incident and recovery evidence in the next Linear
project check-in, even if the runtime has recovered by then: alarm and recovery
times, incident duration, native delivery result, and the issue's evidence link.

This observer runs throughout the service's lifetime, independently of the
[post-update canary](#service-lifecycle). The canary checks a new runtime's health over a
bounded window and reports CPU as an advisory comparison; it does not replace
the sustained CPU/health alarm. Machine pressure can extend a failing canary
verdict, within a bound, without disabling this observer or changing its thresholds.

An operator catalog report with fresh process/session proof preserves the exact
native attachment to that conversation. A bare transcript attachment still
requires complete registered inventories before routing. Service logs retain
`native.health_alert.delivery` with the content fingerprint, conversation,
outcome and fixed routing reason; they omit the alert text and provider errors.
`submitted` includes a retained uncertain native dispatch and does not prove
the recipient read the alert. Inspect its original native acknowledgment.

The public `/health` observation and consented hosted `body.runtime_health`
events contain fixed numeric and enum metadata only. Conversation text, worker
reports, credentials, and command output never enter this projection.

### `doctor`

The install card ([ADR 0142](adr/0142-the-install-tells-him-the-truth.md)).
`clankie doctor` prints one line: `ready`, or the most important problem and
its repair command. Model setup and service reachability take priority over
optional integration warnings. `ready` means these probes found no repair; it
does not prove a model turn or native worker tool acceptance.

Use `clankie doctor --json` for the full, unchanged install card; scripts must
pass this flag. `clankie doctor --machine NAME --json` preserves the machine
card too. Both formats always exit 0 when the card is produced. JSON `ok` means
the card was produced, not that every integration works. `/doctor` in the
console continues to show the full card.

The local card includes `workingPreferences`: resolved global/project values
for the actual current workspace, or an explicit unavailable detail. The TUI
`/doctor` displays these values; the headless command keeps its one-line summary,
so use `--json` to read them. This observation never adds project or tool access.

`trackerCheckpoint` reports the built-in tracker's `tracker.json` (under
`<CLANKIE_STATE>/tracker`) against the single-string limit its open still parses it
under, about 537 MB. It is read from file metadata only. Past half, `state` is `warn`
and a remediation asks for retention or a streamed open (LOCAL-VUH-49). It is absent
when there is no built-in store.

Local fleet discovery uses `<CLANKIE_STATE>/links`, defaulting to
`~/.clankie/links`. Local hires carry the service's absolute state path, including
into the Codex MCP bridge. Doctor and native workers select that same directory;
an explicit private state directory never falls back to shared discovery.
SSH fleets keep their own machine's discovery directory.

`harnessBridges.linkedSession` checks Claude/Codex panes in the discovered local
Herdr session, even when doctor runs outside that session. On macOS it joins the
live foreground harness and bridge ancestry (or the exact dedicated Codex
`--remote`/`--listen` socket) with the bridge process's `HERDR_PANE_ID` and
`HERDR_SOCKET_PATH`. It returns only those identity facts, never the full process
environment. The roster carries the same observation in each seat's
`harnessBridge`; the console flags missing/mismatched bridges and shows the
selected pane's full fix when focused with `Ctrl+G`. Roster polls reuse these
bounded process observations for up to a minute (fifteen seconds once the pane
set changes); doctor takes a fresh sample. The sweep reads command lines and
environments in batches, up to 1,024 node/Codex processes and 256 bridges.

`toolCatalogHealth` reads the service's native catalog diagnostics for current
Claude and Codex panes, including the operator head. The roster carries the
same `toolCatalog` verdict; a mismatch or unverified catalog appears in the
agent dock and its full reason and one fixing action appear in `Ctrl+G`.
`matched` means the harness actually listed the tools its Clankie bridge serves
for that native session. It does not prove a tool call or message delivery.

Current Claude Code's trusted plugin mod reads its actual tool list after
session start (and after clear/resume/compact); MCP discovery can settle for
up to 20 seconds. Clankie-managed Codex launches read `mcpServerStatus/list`
for their original loaded thread. Embedded hand-started Codex has no native
introspection endpoint and explicitly reports `unverified` in doctor/roster.
This is advisory: continue with the current lead and tools the pane exposes;
report a specific missing-tool blocker to that lead. It does not require a new
hire, and routine startup hooks stay silent, including owner interactive panes.
Switching to the shared daemon can break worker bridge pane identity. Native introspection for embedded Codex remains a follow-up.
Plugin hook/mod trust is required; an absent probe remains unverified.
Codex catalog snapshots may use temporary MCP clients. The worker bridge finishes
its bounded health notification before returning `tools/list`, keeping its caller
alive through native proof even if the snapshot immediately closes the bridge.
Notification failure remains advisory; it does not fail catalog discovery or
change proof-refusal alert thresholds.

Claude's pane check reports HTTP refusal codes separately from a link connection
refusal or a timeout, including `remote_observation_timeout` when Windows pane
verification misses its deadline. It retries at idle with backoff and rereads
the current link; a matched check clears the status without forgetting causes
already logged in that process. Persistent native binding failures name
`/mcp` → reconnect `clankie-worker`, then save and restart/resume Claude if needed.
For transport failures, inspect `clankie doctor --machine pc` on Clankie's machine
and its fleet-link logs. A queued observation timeout fails that caller and
retains its exact pending ID for at most 30 further seconds; late replies are
discarded, and a truly stalled observer closes with an explicit log reason.
When that timeout refuses a seat route's pane proof, the service answers with the
retryable `fleet_admission_unavailable` (the observer code in `observation`), so
a worker's `message_clankie` retries its binding lookup instead of failing with
`binding_unavailable` (VUH-2208).
No expired proof or uncertain tool call is replayed.

Doctor observes operator bridges separately from worker bridges; an operator
bridge does not prove worker readiness. Process age is separate from transport
status. `freshness: older-than-runtime` means the observed bridge started before
the running service, with the remedy “seat bridge older than runtime; restart the
seat”. `current` means the bridge started at least as recently as the service;
`unknown` keeps unavailable timing unknown. The optional `bridgeStartedAt` and
`runtimeStartedAt` fields expose the observed timestamps, not build identities.
Age alone does not prove an obsolete build or successful delivery; a same-build
service restart also produces this reload guidance. The roster warns seats it
already lists; doctor also observes the named head's operator bridge.

- `live-process`: the pane has a matching live bridge process. This does not
  verify the native tool catalog, a successful call, or reply delivery.
- `missing`: a live native harness has no observed descendant or dedicated
  socket-matched bridge. For Claude, install/enable `clankie-worker@clankie` in
  that pane's actual profile and restart/resume it. For Codex, check its
  source-owned bridge registration and resume with
  `codex --no-daemon resume <SESSION>`.
- `pane-mismatch`: the observed bridge claims another pane/socket. Check its
  source-owned registration and resume Codex in its own pane with
  `codex --no-daemon resume <SESSION>`. If a shared daemon is observed, save
  affected sessions and run `codex app-server daemon stop` first. Keep
  `daemon_auto_start=false` in the owning configuration source.
- `unobserved`: foreground process or environment facts are unavailable; this
  is not evidence of a missing bridge. Non-macOS host observation is currently
  unsupported; remote fleet native bridge acceptance remains a separate check.

`linkedSession.unownedBridges` names bridges on the linked socket without an
observed native owner. A bridge descending from an actual
`app-server-daemon` executable reports its inherited `claimedPane` and the daemon
stop/resume fix. A daemon's claim alone never assigns its sessions to that pane.
Hand-started `claude`/`claude2` sessions must list `message_clankie`,
`clankie_tools`, and `clankie_call` after the profile fix; installation alone does
not establish acceptance.

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
Credential entries are ids and types, never secrets. A provider can reject a
stored credential before its recorded expiry: on such a rejection in a real
turn the service forces one OAuth refresh. An owner-typed Pi turn continues
once after a successful refresh, within its original run and receipt. Pi omits
the rejected assistant reply from active context while retaining the append-only
failure record; the owner's message, attachments and completed tools are not
replayed. A second credential rejection is terminal and does not force another
refresh. Cancellation prevents continuation. A self-wake retains its existing
one-time recovery. Failed local refresh asks the operator to reconnect with
`/auth PROVIDER`; hosted credentials instead require service operator repair,
with an operator diagnostic and the existing failed-turn telemetry, never a
customer `/auth` step. `credentialRejections` (present only when there is one)
records `{ "state": "refreshed" | "reconnect_required" | "operator_required",
"at", "detail" }` per provider from a real failure, never a new paid probe.
Doctor distinguishes local reconnect from service operator repair; the next
successful turn on that provider clears the entry. The service log retains
`model.credential_rejected` with `providerId` and the recovery `outcome`, followed
by `model.credential_accepted` when a recorded rejection clears. These local and
hosted diagnostics contain fixed metadata, without upstream errors or credentials.
A later successful turn alone does not prove a forced refresh occurred.
`commands` currently probes
`herdr`, `ffmpeg`, `yt-dlp` (version strings) and `herdr-lead`, `codex`, `claude`
(PATH only — never execute `herdr-lead --version`).
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

### `update [now] [--ref REF]` / `update status` / `update cancel` / `update canary`

In a terminal, update shows the live commit, the fetched target, its new commit
count and latest commit summaries, then groups holds by cause with CPU and
health measurements. `status` and `canary` also use plain words. Add `--json`
for structured output; piped output stays JSON. `update --help` lists the flags.

After reviewing holds, the authenticated owner can use
`clankie update --override-holds --reason "why proceeding is safe"`.
An interactive terminal also offers confirmation and asks for the reason;
declining or giving no reason leaves the update held. Each hold gets its own
durable override audit, attributed to the authenticated owner. A new hold
acquired after the prompt still blocks. A passing newer canary releases only its
own hold; historical and independent holds still need an explicit owner decision.
Legacy per-hold flags remain available:
`--override-hold UUID [--actor NAME] --reason TEXT`; the server derives the
audit actor from authentication regardless of the supplied name.

What `clankie update` installs depends on the install. A hosted body runs a
release under `/state/install` seeded from its image and updates like a release
install; a managed body installs nothing newer than its fleet-approved release
(`POST /fleet/v1/body/release`), and refuses with "holding releases" or "not
approved" otherwise. The hosted image also checks hourly and installs while the
body is idle; `clankie update auto [status|on|off]` (TUI `/update` → Automatic
installs) switches that for a self-run body, and managed bodies keep scheduled
checks enabled. Scheduling rechecks this setting and idle state after release
lookup, before accepting the helper, and again after download and staging just
before stopping services. If work starts or automatic installs are disabled,
the verified release stays staged for the next enabled idle check; it is reused
without another archive download. Cutover closes turn admission before shutdown,
so it cannot interrupt a turn. Hourly checks keep a newer image seed when
the approved release is older; an explicit `--ref vX.Y.Z` can still roll back
within the fleet's approval cap.

The release helper uses `clankie update cutover --operation UUID --instance UUID`
(`POST /v1/runtime-update/cutover`) for that final check. Operator authentication
and the exact scheduled operation and running boot are required. It returns
`outcome: "waiting"` with `disabled` or `body-busy`, or `outcome: "ready"` after
closing admission and beginning idle shutdown. An unavailable or uncertain
response leaves the release staged and does not authorize the helper to stop
services or switch `current`.
A release install moves to
the latest official GitHub release, or `--ref vX.Y.Z`; it reports `upToDate` when
already there, and otherwise stages that verified release beside the running one,
switches `current`, and switches back if the new release does not come up healthy
([release updates](distribution.md#updating)). Everything below about status, the
canary, locks and reconciliation applies to both. A source checkout follows `main`:

`clankie update` fetches `origin/main` and stages its exact commit. Named branches
(including `origin/BRANCH` and `refs/heads/BRANCH`) fetch that branch from origin;
failed fetches refuse the update without using a cached or local tip. Use a
commit SHA (full, or abbreviated to at least 7 hex digits), `HEAD`, or `refs/tags/TAG`
for an explicit local target. A hex-looking ref is always a commit, never a branch;
name a branch like `cafe1234` as `refs/heads/cafe1234`. An abbreviation is checked
after fetching `origin/main` (local objects only if origin is unreachable), so one
that is unknown or ambiguous with a newly landed commit is refused. A deploy waiting
for integration batches previews its ref up front (a fetch of up to 60 seconds while
the registry lock is held) and refuses it when it cannot be resolved right then,
including when origin is unreachable. A queued wait that then fails five times, about
75 seconds of continuous failure, is dropped so the integrate queue resumes, and the
lead is alerted once; request the update again afterwards. The result
records `resolvedRef` and `newCommit`, with `older-than-current-pin` or
`diverged-from-current-pin` warnings when applicable. It installs dependencies
in an independent detached worktree and schedules a fixed helper in a separate
process group. The current
service must be running the exact pinned checkout. Dirty tracked or untracked
files in that checkout refuse the operation before any service stop.

#### Batched checkout updates

A source checkout batches the updates that follow `main` (`main`, `origin/main`,
`refs/heads/main` or `refs/remotes/origin/main`; VUH-2393). Every cutover
restarts the service and the Discord bodies with it, and Clankie used to update
after nearly every landing: 250 cutovers in eleven days. A request applies at
once when the body is idle (no captain turn, activity share or voice call, and
no worker agent `working` in any fleet) or when the running service has been up
for the batching interval, two hours by default (`CLANKIE_UPDATE_BATCH_MINUTES`
on the service). Otherwise it answers HTTP 202 with `accepted: false` and
`deferred` (`requests`, `firstRequestedAt`, `dueAt`, `initiator`), and the CLI
exits 0. The service checks every minute and applies the newest `main` once the
body is idle or `dueAt` passes, under its own authority and through the same
deploy holds, canary and rollback; a batch whose `main` has no new commits is
dropped without a restart. A hold or a failed fetch keeps the batch waiting.
`update status` shows a pending batch as `deferred`. An active integration attempt
holds deployment until its safe point or its sixty-minute automatic hold expires,
even after `dueAt`; status names the blocking batch UUIDs.

`clankie update now` (`{"now": true}`, or `now: true` on `update_runtime`)
applies at once. So do an explicit `--ref` (a commit, tag or other branch, such
as a rollback target) and a hold override. `clankie update cancel`
(`DELETE /v1/runtime-update/deferred`) drops a pending batch and reports
`cancelled`. The record lives at `~/.clankie/updates/deferred.json`.

The helper installs before stopping anything, rechecks the pin, stops through
the existing service supervisor, retains the previous worktree, activates the new
pin and restarts the pin-dependent services. The external activity tunnel stays
running under its current owner; an unowned tunnel cannot block the update.
The relay, the activity surface and keep-awake stay running when none of their
code changed: the helper follows each entrypoint's static and literal dynamic
imports through the workspace and keeps the service when the range touches none
of those files, their packages' manifests or assets, or the root lockfile and
manifests. Any import it cannot follow restarts the service. A kept service
keeps running from the previous worktree, which retention keeps while it runs;
the record lists it in `keptServices`. The Discord bodies always restart with
the service, because their live presence claim is only valid against the
service instance that issued it. A rollback restarts everything. Failed new health checks trigger a
confirmed-stop rollback. Unknown shutdown never authorizes a worktree move.
Generated pnpm wrappers and known workspace metadata are relocated before cutover;
committed source, lockfiles and global package-store files are not rewritten.

After confirmed new service health, the helper refreshes existing Claude/Codex
plugin links locally and on enabled SSH fleet machines through
`clankie harness install --refresh-linked`. Plugin refresh failures leave the
healthy service running and report `harness-refresh-incomplete`; they do not
roll back the service. `harnessRefresh` in update status links the complete
per-profile receipt in `harness-refresh.json` beside the transaction record.

After the new service responds with its exact boot identity, a persistent
post-update canary observes it for five minutes. It holds only on an unhealthy
new service: sustained missing, stale or wrong-identity `/health`, a sampling gap, or
`/health` p95 over its 250 ms default budget, sampled every 10 seconds. Health
latency includes TCP setup and the complete response on a fresh loopback HTTP
connection. Captain-process CPU (100% means one core) is recorded but never
fails the canary: an absolute CPU figure depends on the machine and its fleet.
`update status` (`canaryCpu`) and `update canary` (`cpu`) report the new mean
beside the previous runtime's recorded mean on this machine, their ratio, and
whether it exceeds the advisory `cpuPercent` (default 10). Its deploy hold blocks
further updates and integration landings during observation. A pass releases
that canary's hold and verified older canary holds admitted by its override or
superseded through the recorded installed-runtime chain. A health regression or missing health signal records a
failed canary, retains the hold, names the
previous healthy commit, and sends its numbers, budgets, hold-release command and explicit rollback command to the initiating lead conversation (or the default owner conversation for CLI/scheduled updates). The new
pin keeps running; rollback requires an explicit owner decision. Alert status
distinguishes submitted, unavailable, and an uncertain claimed attempt.
Submitted means the native notification path accepted the attempt; it does not
claim a confirmed recipient receipt.

The canary samples host load before and after each health probe. It subtracts
service CPU (converted to cores) from the busier of the 1-minute and 15-minute
load averages. Kernel per-core tick deltas measure current busy CPU across each
interval, including short-lived forks. Before a valid CPU interval is available,
it uses the external load ratio instead. External CPU above half the cores marks
that sample as pressured.

Pressure never discards a sample or delays a pass, because load can only inflate
the runtime's own latency. At the end of the first window, a health p95 within
budget passes however busy the machine was. CPU stays advisory and comes from the
runtime process alone.

A transport timeout under pressure is not ignored. It counts against the
window's p95 as an over-budget probe, so a runtime that misses more than one probe
in twenty cannot pass on the probes that did answer. A scheduling gap under
pressure counts the same way.

Pressure only extends a failing verdict. If the first window's p95 is over budget
and the window contained pressured probes, the canary judges fresh,
non-overlapping windows. It passes once two in a row fit the budget. The extension
is bounded at five more windows, at most one hour (by default it decides within
about 30 minutes). At the bound it fails with
`runtime-canary-latency-budget-exceeded-under-pressure`, or with the
health-unavailable diagnostic when too few probes answered, and keeps its hold. A
busy machine can therefore never leave a canary pending indefinitely.

A quiet window over budget still fails at its end. Wrong identity, unhealthy HTTP
and invalid metadata fail as on a quiet machine: within the existing
three-interval budget in the first window, and at once during an extension. A
quiet transport miss keeps the three-interval budget throughout. A service restart
begins a fresh observation and bound, but an extension carries over (in
`canary-extension.json`), so the canary still needs two windows in a row.

The lead receives one extension notice with recovery commands. `update status`
and `update canary` expose the pressure state and load observations, and the
extension's progress appears in the canary's `error` field. Pressure metadata
lives beside the operation in `canary-pressure.json`, preserving older runtimes'
cutover journal readers.

`update status` reports top-level `phase: canary-failed` and `canary` for a
failed observation, and exits 1 in both terminal and JSON modes. The nested
`latest.phase` remains the historical cutover result. Pending observations
report `phase: canary-pending`; terminal output does not call either healthy.
Definitively unavailable alert delivery retries; a claimed uncertain delivery
never replays. No canary automatically rolls back or restarts the service.

After a passed canary releases its hold, source-worktree installs automatically
release obsolete update worktrees. The current pin and that cutover's immediate
`previous` stay. Failed or pending canaries and unresolved recovery operations
protect their worktrees and referenced commits; live processes, dirty or locked
trees, missing completion evidence and unverified native Git identity also hold
removal. An unreadable journal, uncertain current/previous identity or incomplete
process inventory refuses cleanup; a process read that fails while processes
change is retried twice first, and a timed-out one is not. Update admission and retention share a lock.
No forced removals, worker-worktree tidy or operation/receipt deletion occurs.
`clankie update status --json` includes the last `retention` inspection, bounded
removed/retained lists and counts. `retentionMaintenance` and `retentionPending`
name a currently held cleanup lock or unconfirmed removal even when its record
is unreadable. Complete effect evidence stays in private
`~/.clankie/updates/retention.log`; operation journals remain beside it.
Retention runs once per passed operation per service boot, rather than on every
canary poll. Recovery in a new service process inspects retention again; failed
maintenance callbacks remain retryable. A removal first moves the worktree into
private `~/.clankie/updates/retention-trash` with one rename, drops its Git
registration, then deletes the moved tree with no timeout, so an interrupted
removal leaves trash, never a half-deleted registered runtime.
`retention-pending.json` records that removal until it is confirmed. The next
retention run or update admission finishes it, including a marker an older
version left when a timeout killed `git worktree remove` partway, provided it
names a retention worktree of a recorded operation at its recorded commit,
unlocked and unused. Otherwise it refuses with the reason and needs owner
reconciliation, as a held `maintenance.lock` always does. A failed removal
records its timeout or signal, exit code and stderr.

An unavailable sample stays pending and is retried at the configured interval.
On a quiet machine, no verified health for three sample intervals (30 seconds by default), or
unavailability at the window's end, fails the canary. A recovery before that
deadline clears the temporary error; failed samples never count as healthy
samples. Pending and failed records name the failed check and underlying local
transport error (including timeout causes), without retaining response bodies.
Identity mismatches name the first differing field (`root`, `commit`,
`instanceId` or `pid`) and its expected and actual values in the existing error
string; unusually long path values are explicitly truncated to fit its bound.
Only a runtime booted at the candidate commit resumes sampling a pending healthy update.
An old or foreign observer of the shared latest journal leaves that observation
alone while the armed process is alive or its exit is unproven. A confirmed
armed-process exit followed by a different-commit boot serving verified healthy HTTP fails the
interrupted window. The candidate still checks its complete boot identity over fresh HTTP;
a persistent replacement fails within the existing availability budget.

To clear a failed canary's hold after reviewing runtime health, read its full
hold UUID with `clankie update status --json` or `clankie integrate holds`.
Explicitly release that UUID with
`clankie integrate release UUID --actor NAME --reason "why this hold is safe to release"`;
the release is audited. This does not change the historical failed canary or
claim it passed. Alternatively, the authenticated owner can authorize one
update with `clankie update --override-holds --reason "why proceeding is safe"`.
That override is audited per hold and retains the holds until the admitted
update passes its full canary. The pass releases exact overridden canary holds
and verified canary holds from the recorded installed-runtime predecessors.
Independent holds, changed owners/reasons and unreadable provenance remain
blocking. Historical failed canaries stay failed; cleanup adds audited release
events. Restart recovery retries stale-hold cleanup even if the latest canary
already released its own hold.

A completed operation is no longer reported as `pending`. Reads leave its
terminal lock intact; the next admitted update retires it before scheduling.
`accepted: false` names `blockedReason` (`update-in-progress` or
`runtime-maintenance-busy`); a hold override cannot bypass either. Let an active
operation or maintenance finish, or reconcile an uncertain result through the
normal operator path. Never edit journal files or remove locks by hand.

To deploy this behavior from an older runtime with a reviewed stale canary hold,
explicitly release that hold using the command above, then run
`clankie update --ref main --json`. Verify `accepted: true`, finish the turn,
and read update status afterward. A confirmed `accepted: false` schedules
nothing; inspect the reason before retrying. A lost response remains uncertain.

`clankie update canary` reads the policy and last canary. Configure the next
update with `--window-seconds N`, `--sample-seconds N`, `--cpu-percent N`
(advisory only), and `--health-ms N`; omitted fields retain their values. Policy changes do not
change an in-flight observation. `/update` offers the same settings in the TUI.
A restart of the observed service starts a fresh full window for its new boot
identity; elapsed downtime never counts as healthy observation.

The service also schedules an in-place tool refresh for running workers. Local
managed Codex controllers keep their original thread and descendants, wait for
idle, atomically persist the proven Clankie bridge registration, its tool approval
and transport revision with a native config version check, and reload once.
A renamed bridge that previously existed only in launch flags becomes a valid
on-disk registration; legacy controllers keep their original server name. A lost mutation acknowledgment is held for
read-only reconciliation. If an acknowledged reload's original native runtime
reports failed startup, a fresh guarded transport revision can repair it in
place; the failed generation is retained. No turn or uncertain report is replayed.

`clankie harness refresh-tools [--pane PANE]`, TUI `/refresh-tools [--pane PANE]`,
and the operator tool `refresh_worker_tools` refresh the caller's led or hired seats when no pane is selected. Other seats return `skipped-not-owned`; they require an explicit pane and authenticated owner API/CLI authority. The owner CLI defaults to the default owner conversation.
The authenticated API is `POST /v1/fleet/worker-tool-refresh` with `{}` or
`{"paneId":"PANE"}`. Each result is `refreshed`, `catalog-refreshed`,
`skipped-busy`, `skipped-not-owned`, or `failed` with a reason. Local Codex returns
`catalog-refreshed` with `original_codex_next_turn_tools_unverified`: the original
thread's MCP catalog is connected and complete, but the next model turn's tool
exposure and report delivery have not been tested by this command. Codex 0.161
rebuilds tools at each sampling step; owner exposure settings can still omit
tools from the model while the native catalog lists them. Verify in the same
worker thread with `clankie_tools`, then one distinct `message_clankie` report;
retain the stored receipt. Refresh never manufactures that turn or report.
Local Codex results also include bounded `detail` evidence:
native catalog status/errors or the loaded thread inventory behind a scope
refusal. Busy requests remain pending under their original authority.
Roster `workerTools` and `/doctor` show observed/expected plugin versions and
whether the observed runtime revision is behind. A Claude seat still running an
older plugin is never reported `refreshed`: it fails with
`original_claude_plugin_unchanged`, because its plugin loads only when its session
starts. Its `detail` and the pane's older-plugin notice name the step that loads
it: between tasks, close the pane and resume its session with `hire_agent`
(`resume` set to its transcript ref), keeping its context. For a hired remote Codex
seat, retain its report, settle original receipts, and wait for a confirmed
`closed` result before resuming `FLEET:SESSION_ID` with the same harness, fleet and
working directory. Clean unlanded commits can remain there with an explicit
`unlandedReason` explaining their retained handoff; dirty or unknown Git evidence
still refuses. `undo_worker_pane` within five minutes uses the ordinary guarded
hire/resume path and rescans for the same thread before hiring. A refused close
leaves the worker intact. `close_unconfirmed` retains close history for inspection;
`start_unconfirmed` retains the original launch receipt. Inspect either uncertainty
before another action; never replace or blindly repeat that launch.
Local Codex seats started on
worker plugins before 0.6.5 show **restart needed** instead of an in-place refresh
success. Automatic restart of those legacy seats is disabled. They retire
naturally; deployment or refresh never quits them. The lead may close an idle
legacy seat through the existing tidy path and hire a fresh worker with the
current plugin. First retain its handoff, issue/evidence links and original
thread reference, settle original receipts, and check that it has no unsent
draft. The old thread's evidence stays on disk; a fresh hire receives that
handoff as context, rather than replaying an old report or resuming the old
thread automatically. See the [manual retirement steps](testing/worker-tool-refresh/manual-proof.md#pre-065-local-codex-manual-retirement).

The compatibility command `clankie harness restart-tools --pane PANE` and
`POST /v1/fleet/worker-tool-restart` remain safe refusal surfaces for local
Codex. An otherwise eligible idle target returns `native_exit_unavailable`
before any close/history intent. They are not the manual retirement path and
do not enable supervised quit/resume. Remote Codex and Claude remain VUH-1742.

Known native busy state also holds deployment metadata publication until idle.
The current implementation cannot safely refresh remote Codex configurations
or recover their original controllers after a service restart. Claude supports
native list-change adoption for an already current bridge, but replacing old
imported bridge code remains unverified. Remote Claude waits while busy, then
returns `original_remote_claude_imported_bridge_refresh_unsupported` without
signalling a refresh: root-only health cannot prove imported-code replacement
or adoption by all loaded descendants. On-disk cache versions are not loaded
versions. No remote session is restarted or migrated by this command.
OpenCode verifies the original native
MCP connection; its public SDK does not expose exact model-visible MCP names.
These cases remain visible per-seat failures or verification gaps, never
successful refresh claims. See [ADR 0235](adr/0235-worker-catalog-refresh-keeps-the-original-controller.md).

The CLI and TUI `/update` return an accepted/pending operation, not a success
claim. `clankie update status` and `/update status` read the durable old/new commit,
phase, per-service receipts and exact service boot identity. `initiator` records
the authenticated operator or host-admitted conversation. CLI environment seat
session/conversation claims are explicitly marked as claims, not authority.
Newer result evidence is tolerated by readers; damaged known fields produce a
JSON reconciliation error and leave the operation and lock untouched. CLI status
also reports unavailable or non-JSON server responses as JSON. Results live in
private `~/.clankie/updates/<operation-id>/` directories and survive the old
service exiting. A nonterminal operation or uncertain shutdown blocks another
schedule; inspect/reconcile that operation rather than retrying or deleting its
lock. PIDs alone are never proof that an abandoned operation is safe to repeat.
Scheduled means the helper has not yet reported progress; installing means it
is preparing the replacement. Finish the initiating turn, then read
`clankie update status`. During shutdown, a brief disconnection is expected:
the old service drains its process group and seat bridges reconnect to the
replacement. Wait for that reconnect and read status; the update owns its restart.
The helper runs from private copies in the operation directory that import only
Node builtins and each other. One that stops before claiming its operation, for
example because it cannot load, has changed nothing: it records `failed` with
`pre-cutover-failed`. The live runtime was not replaced, and another
`clankie update` can safely retire that lock and retry, subject to deploy holds.
If it could not record even that, an operation still `scheduled` and unclaimed
ten minutes after acceptance is recorded the same way when the service next
starts or admits an update. Reading status alone never retires or reconciles it.
The helper retries a stop or restart it could not confirm, after 10 seconds and
then 30, before it rolls back or reports the step unconfirmed; the result keeps
each step's latest receipt and `service-attempts.jsonl` beside it keeps every
attempt. A deploy that stopped services and still ended `stop-unconfirmed`, or
`failed` without a confirmed rollback, may have left them down: the runtime that
boots next sends one runtime-health alert to the initiating conversation, or the
owner's, naming the unconfirmed services. An operation that ended
`stop-unconfirmed` or `failed` reconciles itself when the service next starts, and again before the next update, once three facts hold: its
helper wrote that final result as its last log line, the pin is a clean detached
worktree at the old or new commit, and the running service booted from that exact
pin. The result gains `reconciled` (time, commit, instance) and the lock is kept
beside the operation as `active.reconciled-ID-TIME`. A deploy hold the canary
armed for that operation before it could begin is then released as well. Anything else, such as a
missing or edited pin, still needs the owner and is never repaired automatically.
Until that proof appears, keep the original operation and lock, inspect its
status and ask the owner to review it; do not resend the update or restart to
work around it. Once status reports `reconciled`, another update is permitted,
subject to remaining deploy holds. Terminal output includes the recorded reason,
failure and rollback details so the next step follows the actual evidence.

The operator API is `POST /v1/runtime-update` with optional `{ "ref": "main" }`
and `GET /v1/runtime-update` for status. It requires the actual operator credential;
caller-supplied lane, actor and path claims confer no authority. Captain tools
`update_runtime` and `runtime_update_status` exist only in host-admitted machine
sessions and recheck their captured source before acceptance. Social sessions
cannot gain the tool through a later permission change. Accepted host operations
may finish or roll back after the original turn/service exits.
Targets predating the canary coordinator are refused before installation or
service shutdown (`target-runtime-canary-unsupported`); their health parser
cannot complete the new observation. An owner choosing a legacy rollback must
review it through the installer rather than bypassing the pending update record.

`GET /v1/runtime-update/canary` returns `{policy, canary}`;
`PUT /v1/runtime-update/canary` accepts a partial policy with `windowMs`,
`sampleIntervalMs`, `cpuPercent`, and `healthLatencyMs` and applies it to the next
canary. Both require current operator authority; policy publication rechecks it
inside the lock and immediately before replacing the durable file. Revocation
retains the previous policy. The local `/health` response
also exposes `processHealth`: a boot UUID, PID, uptime and cumulative process
CPU microseconds. Boot identity comes from the running updater's immutable
identity; liveness probes do not reread update transaction files. The response
carries no messages, prompts, tenant content or credentials.

Integration attempts automatically acquire bounded deploy holds through composition,
gating and push. Updates wait on these holds; waiting or accepted deploys keep new
attempts queued. `update status` names each `integrationBatchId` and its time left.
An immediate request answers HTTP 202 with `accepted: false`, `pending` and
`waitingForIntegration: {id, ref}`; the CLI exits 0. That intent survives service
restart and retries hold admission every fifteen seconds. `update cancel` cancels
it, including when the underlying source-update batch has already become due.
Manual and canary holds retain their refusal and explicit override behavior.

Deploy holds block runtime-update admission. `update status` and an `update`
refusal list each hold's holder, how long it has held, the time left and the
holder's presence. An operator may override explicitly with
`--override-hold UUID --actor NAME --reason TEXT` (repeat the hold flag for every
hold); the registry records the override and retains the hold. A reviewed hold
that lifts before admission needs no override. The API accepts an `overrides`
array of `{holdId, actor, reason}`. See [integration](integration.md#deploy-holds).

Supported `clankie mcp` operator bridges reinitialize after an explicit
`unknown_session` rejection before tool admission and retry that rejected request
once. Concurrent requests share the new session; reconnect drains old HTTP clients
without closing another pending call. The refreshed tool list lets the same
attached seat inspect the result.

For exact completion, pass `message_seat`'s returned `messageId` to
`herdr_watch({agent, reason, messageId})`. A fast turn may finish before you arm
that watch: scoped admission still observes that exact completion, never a
pane-level `done` from another turn. Codex queued inputs return a
`codex-input:<native client ID>` identity before the native turn exists. On local
seats with an observed native endpoint, completion is joined by the native
`userMessage.clientId` to its actual turn, including after service reattachment.
Confirmed Codex follow-ups with IDs also arm an automatic watch. Re-arming a
harvested identity returns `settled_for_message` with its retained completion
(or `already_harvested` for legacy claims without completion data); it does not
wake the lead again. Without `messageId`, watch status remains a pane-level cue.
An unavailable exact native controller reports unconfirmed correlation rather
than substituting another turn or terminal input. Remote queue transports that
provide only legacy boolean receipts still lack message-scoped correlation.
A watch that observes unverified completion while the pane is still `working`
joins the next lead report round. It stays armed and does not repeat that
working notice, including after service restart or re-arming the same watch.
A changed state can report again; failures, blocked turns, questions and gone
panes keep their immediate delivery. Clean completions keep joining the round.

Codex completion watches poll retained turn IDs/statuses without loading items.
They refresh full history on a change or after 30 seconds unchanged, to recover
late queued-input attribution. Only a fresh, unambiguous full-item response
settles a watch; native summary pages omit later inputs and earlier result text.
Reads are sequential and bounded to 10,000 turns, with a 10-second metadata
pagination budget (an in-flight request has its own 5-second timeout).
Unsupported or invalid native pagination reports unavailable correlation.

Protected `message_seat` and `hire_agent` calls receive a `deliveryId` or `hireId`
before dispatch, carried in MCP `_meta["clankie/seat-call"]`. The service persists
the scoped receipt before the native effect. A lost result returns typed
uncertainty with that original ID; reconnect never replays the pending action.
Use `reconcile_seat_call({deliveryId})` or
`reconcile_seat_call({hireId})` in the owning operator conversation to inspect its
original receipt, without sending again or launching a replacement. When the
bridge that minted an ID reconciles it and the service has no receipt, the call
never arrived: the ID is closed as not dispatched, so a late arrival is refused
and the action may be sent again as a new call. Any other unknown ID is left
open. A settled
call receipt returns the original tool result, not proof of task completion. The
journal keeps the latest 1,000 settled result bodies; older IDs remain
non-replayable and report an expired result, while uncertain originals remain
retained. Receipts survive restart within these retention bounds. See
[ADR 0207](adr/0207-work-records-and-native-agent-delivery.md#mcp-reconnect-and-native-call-receipts-vuh-1638).

Fleet bridges retain their separate exact-link refresh and durable receipt rules.
Already-loaded older operator bridges need their MCP process refreshed to gain
these protocols; refreshing only the fleet mailbox is insufficient. The native
seat need not be restarted for a supported bridge.

`clankie hire-receipt settle ORIGINAL_NATIVE_HIRE_UUID` calls the operator-only
`settle_hire_receipt` operation. This is the native hire receipt UUID, not an MCP
call UUID or a `seat-…` message acknowledgement. The service takes a fresh census
through the original configured SSH host/session and closes its guarded host
reservation. Only a reservation whose entire window precedes every pane, process,
session or resume/send effect can become `settled-not-launched`. Evidence records
the original key/fingerprint, target, host identity, interval and census digest.
An irreversible service launch flag and the host's exclusive launch/seal transition
prevent a late dispatch or a reset host journal from granting settlement.

Legacy receipts without that recorded window, already allocated panes, attempted
launches, incomplete census, changed connection or revoked authority are refused.
Current absence cannot reconstruct history. Receipts and evidence are retained;
the original key stays blocked permanently and no request is resent.

Fresh-hire recovery also accepts the retained `freshIntent.id` instead of the native
receipt UUID: `clankie hire-receipt settle FRESH_INTENT_UUID abandoned` (or
`abandoned-unknown` / `not-launched`, subject to the same host evidence requirements).
The lead tool `settle_hire_receipt({receiptId, disposition})` may settle only its
own conversation's fresh hires. Private operator conversations, including the
native operator seat, may settle any retained hire; project delegation and room
tools retain their ownership boundary. Operator API/CLI recovery has the same
operator authority.
The result names the requested UUID; its evidence keeps the original native receipt
UUID and key. No old brief is sent, and no pane is closed. A separately authorized
new hire may name either settled UUID in `freshIntent.afterReceiptId`.

`clankie hire-receipt settle PROJECT_ALLOCATION_UUID release-allocation` releases
an inactive, unconfirmed project hire claim after a complete native inventory.
Use the allocation UUID from the retained project-hire evidence, rather than a
native receipt UUID. It refuses a present original pane, any worker in that
working directory, an unresolved native hire receipt in the same fleet/directory,
changed allocation evidence or unavailable inventory. Settle the original native
receipt first; retain a present worker's handoff and retire it explicitly.
The command preserves launch history and records the release time and inventory
digest. It closes no pane, replays no receipt and starts no replacement. Repeating
it reads the retained disposition. Definite failures before native dispatch now
release their project allocation automatically; uncertain launches stay held.
The operator's `settle_hire_receipt` tool also accepts `release-allocation`.
A project allocation UUID supplied with `abandoned-unknown` is refused with this
recovery instruction: a project-only claim cannot assert an unknown native launch.
See [the refusal and recovery evidence](testing/2026-10-07-project-hire-refusal/README.md)
for the local VUH-1702 and PC Ada/Pell recovery commands.

A local hire has no host reservation window, so `not-launched` refuses it.
`clankie hire-receipt settle ORIGINAL_NATIVE_HIRE_UUID abandoned` settles an
uncertain local hire from this machine's complete Herdr inventory instead
(VUH-2243). It requires no live occupant in the original pane: the pane is
absent, or holds no reported harness or session and its own shell is its only
foreground process. With no recorded pane, no pane of that harness may run in
the directory. A harness, session or other foreground process refuses; adopt or
retire that worker instead. Two censuses must agree. The evidence records the
original key, brief fingerprint, pane observation (shell PID when present) and
inventory digest. It claims neither launch nor delivery. The original moves to
`local-settled:ORIGINAL_UUID` in the receipt journal, so a new hire into that
directory starts normally. Nothing is sent, replayed or closed, and repeating
the command reads the retained disposition. A local project allocation whose
original pane is absent or holds only its own shell can then be released with
`release-allocation`. Failed starts expose the original native `receiptId` to
the hiring lead. Older failures that omitted it can be recovered by the operator
with `clankie hire-receipt settle ALLOCATION_UUID abandoned`: the service resolves
exactly one retained local receipt with the same harness, directory and pane,
then applies the same two-census abandonment. The result returns that native
receipt UUID. Follow with `clankie hire-receipt settle ALLOCATION_UUID
release-allocation`; no launch history is rewritten and no brief is replayed.

`clankie hire-receipt settle ID adopt` is the operator's path for a local hire
that launched but never confirmed, so its hiring lead cannot reach it (`message_seat`
refuses "native occupant no longer matches its persisted owner"). `ID` is its local
native hire receipt UUID or its project allocation UUID; a hire stopped at
`trust_required` and then trusted by hand has only the allocation. Adoption needs
the harness the hire named, with a reported session, running in the pane the hire
recorded and in its directory. It also needs the conversation that hired that pane
and, for a project allocation, a current process proof of the same occupant. Two
censuses must agree. It binds that occupant to the hiring conversation, confirms
the allocation and starts that lead's watch. A receipt settles as `adopted` and
moves to `local-settled:ORIGINAL_UUID`. The brief's delivery stays unknown, so
the lead should message the worker to confirm its task. Adoption sends, replays
and closes nothing. Once adopted, the lead retires the worker with
`close_worker_pane` and its usual checks. An absent pane or a pane without that
harness refuses. Repeating the command reads the retained adoption.

`clankie hire-receipt settle seat-ORIGINAL_UUID delivered` records historical
native insertion through the same authenticated host census. The service resolves
that exact event in its canonical mailbox journal and uniquely links its fingerprint
to the allocated remote hire. It requires the original native channel event ID,
recipient conversation, complete body hash, canonical cwd, native channel-origin
metadata, and session UUID derived from both the confined transcript filename and
metadata. A legacy event without a stored recipient binding also needs its exact
retained bridge acknowledgement. The evidence explicitly labels the historical
binding reconstruction; it does not adopt the old session or claim work completed.
Ambiguous, forged, truncated, redirected or changed histories refuse.

`clankie hire-receipt settle ORIGINAL_NATIVE_HIRE_UUID abandoned` records the
operator's explicit disposition of a legacy allocation with current authenticated
pane/process/session census. It preserves uncertainty about prior launches and
keeps the original key blocked permanently. It does not close panes. Close an old
allocation only with owner authorization and fresh proof of its exact ownership,
idle state and empty draft; otherwise list it for the owner. New acceptance work
needs separately authorized fresh intent, not a replay or an automatic key change.
All original receipts, bridge acknowledgements and host recovery history remain
retained. Neither recovery command sends, relaunches or adopts an original.
An abandoned host-operation lock is a refusal, never an invitation to delete it.
`clankie hire-receipt settle ORIGINAL_NATIVE_HIRE_UUID abandoned-unknown` is a
separate operator decision for a fresh remote Codex hire whose worker allocation
was never recorded. After launch commitment it requires the existing exact host
launch journal. Before launch commitment, a lost reservation call or ACK may
leave a reserved or missing journal: recovery writes a host tombstone after a
fresh complete authenticated census and records `launchHistory: uncommitted`.
That disposition preserves uncertainty about the missing history; it does not
manufacture a no-launch window. Delayed reservation and launch calls refuse the
tombstone. Both paths require the original admission, no active local original,
and current authority. Mapped allocations, resumes and other harnesses refuse.
The retained disposition
is `abandoned-unknown`: allocation fate stays explicitly unknown, with no pane
identity, absence assertion or delivery claim. It records the operator's approval
of separately new work as `freshIntentAllowed: true`; an unobserved original
could still finish. The original remains permanently fenced. A new hire needs a
different brief and explicit fresh UUID under the usual owner, project, target
and unresolved-sibling checks. This operation grants no pane-close or adoption
authority. If a host write succeeds but local settlement loses authority, retry
only recovery of that exact original; the host appends a fresh census.

The host OS and configured SSH principal are trusted; a compromised host cannot
attest its own history. The journal covers service-authorized effects, not arbitrary
programs launched outside Clankie's controlled hire path. It adds no fleet tool,
worker authority, account setup or TUI setting.

A running native seat bridge declares its loaded capabilities on each authenticated
`GET /v1/seat/events` poll through `x-clankie-seat-capabilities`: schema version 1,
`eventKinds`, `ownerOrigin`, and its captured `sourceHash`. A service update cannot
change modules already loaded in that bridge. No declaration means the legacy
`wake`/`watch`/`escalation`/`message` wire contract. Owner turns then use `message`
without the newer `ownerOrigin` field, with verified attribution in the content;
the original ID, delivery receipt, and normal conversation answer remain the same.
A bridge receives only declared kinds and fields. Unsupported events are refused
before dispatch rather than handed to a decoder that cannot read them.

`clankie status` (`seatBridges`) and `clankie doctor` name a stale receiver and
advise `Clankie's seat needs a reconnect: /mcp`. The operator-only `seat_bridges`
dispatch operation returns the same loaded capability observation. It is a
read-only diagnostic, not receipt acknowledgment. A stale bridge notice appears
in the shared owner conversation without queuing another turn. If an owner turn
was taken but never acknowledged, a second notice names its original ID; its
uncertainty receipt stays retained and is never automatically replayed. Reconnect
the operator MCP bridge with `/mcp`, then check a fresh owner turn. A service
restart alone cannot refresh an old native MCP process.

`clankie seat-delivery list` reads the operator-only `seat_deliveries`
operation: unresolved head and worker mailbox deliveries, plus native delivery
fences that block a worker recipient. Entries include conversation, exact
receipt ID, worker seat ID when applicable, and age when a start time was
recorded. Native fences remain visible after their mailbox ACK. An unresolved delivery refuses only a resend of that original, by
ID or exact content; unrelated wakes, watches and worker reports keep reaching
the seat, and the seat receives one `seat-delivery-alert` message about it. Once the seat
acknowledges that alert it is not repeated, even after a service restart; an
alert that did not reach the seat may be tried once by the next process.
`clankie doctor` lists the same entries. For a worker channel,
`reconcile_seat_call` accepts the returned native `messageId` as `deliveryId`,
or the original MCP dispatch UUID, in the original conversation. An exact
retained ACK reconciles the native fence without sending anything. A bridge
ACK proves transport delivery, not that the model consumed or acted on it.

A native fence also blocks different messages to that recipient. The lead can
settle it with `reconcile_seat_call({deliveryId, settle: "not_delivered"})`.
Proven arrival is recorded as delivered. Anything else is recorded as not
delivered (`settled: "not_delivered"`) and kept as `abandoned-unknown` evidence.
The persisted hiring lead can also settle a blocking receipt recorded by another
conversation, provided the receipt still matches its hire's exact pane and native
occupant. Foreign leads gain no access to that hire's receipts.

Reconciliation checks the original channel ACK and exact session transcript.
If the pre-send transcript baseline is missing, an exact complete message with a
native timestamp after dispatch can prove arrival; older or undated text cannot.
On the next reconciliation or send after a restart, an interrupted receipt stops
blocking after five minutes even if the transcript is unavailable or the worker
is busy. Its fate stays `abandoned-unknown`; expiry does not prove non-delivery.
Within one running process, an absent original still requires an idle recipient
and readable exact transcript before automatic settlement. None of these paths
sends anything or replays the original (VUH-2358, VUH-2535).

`clankie seat-delivery settle RECEIPT_ID abandoned-unknown [--conversation ID]`
(default `global-default`) calls `settle_seat_delivery`. It is the owner's
explicit decision that the event's fate is unknown: the original stays retained
under its ID with `abandoned-unknown` evidence, never claims receipt, and is never
resent; a later delivery under the same original ID is still refused. Use it
only after the native transcript shows the event never arrived or cannot be
inspected; if it did arrive, acknowledge that exact ID instead. In-flight and
unknown IDs refuse. Never edit the receipt journal by hand.

`clankie hire-receipt fresh --json-stdin` admits separately authorized new remote
work after a retained settlement. Supply an existing hiring conversation, a new
brief and `seat.freshIntent` through the public `spawn_seat` request:

```json
{
  "conversationId": "conv-YOUR-HIRING-CONVERSATION",
  "seat": {
    "schemaVersion": 1,
    "fleet": "pc",
    "harness": "codex",
    "title": "Ada",
    "role": "tester",
    "workingDirectory": "C:\\work\\approved-repo",
    "freshIntent": {
      "id": "f219ef86-91ba-4697-8e2e-91fc9416e72c",
      "afterReceiptId": "9ef6657c-2d09-4b15-85b4-04608168a532"
    }
  },
  "brief": "The owner authorized this independent new task. Complete its bounded acceptance check."
}
```

Save the request before calling `clankie hire-receipt fresh --json-stdin < request.json`.
Choose one new lowercase UUID for that intent and retain it. `afterReceiptId` is
the exact **native hire** UUID or retained **fresh intent** UUID of the latest settled original, including when delivery
recovery used a `seat-…` message ID. Use the original fleet, harness and exact
working-directory value; its configured host/session must still match. Resume,
an unresolved sibling, changed authority or replay of any retained brief refuses.
The service records the captured owner, resolved project/launch settings and
brief fingerprint before any new effect. A reused UUID with different scope,
owner or brief refuses. An exact retry only inspects the original native binding;
it never launches or sends again. A completed fresh UUID stays fenced permanently:
use its existing seat for follow-up. Both original settlement evidence and fresh
receipts remain retained, including across restart and age pruning. Older service
versions may refuse this journal; upgrade forward rather than editing its records.

A successfully delivered hire also counts as settled after a complete native
inventory proves its original pane absent, including after `close_worker_pane`
or harvest. The service checks the original configured host before and after
that census and retains the completed receipt and retirement digest permanently.
Fresh admission performs this census for older completed records too; no original
launch or brief is resent. A live pane, unavailable inventory, changed host or
unresolved sibling stays blocked. Refusals name the expected receipt and fresh
intent UUID when known; use those exact identities for separately authorized work.

The native `hire_agent` tool accepts the same optional `freshIntent`. This adds
no account change, fleet alias or TUI setting. Exit 0 from the fresh CLI means
the service returned `spawned`; completion still needs the matching native event.

### `integrate`

`clankie integrate status UUID` includes each repository's `reviewChecks`:
the parent's exact-patch verdict after the gate and immediately before push,
with the checked base, HEAD and time. Unavailable verdicts record their error
and hold landing. These receipts cover app gates that have no review step.

Default landing is direct: commit to `main`, `git pull --rebase origin main`,
run `clankie heavy -- pnpm check:landing`, then push
([ADR 0240](adr/0240-changes-land-directly-on-main.md)). `integrate` is optional
when you want a composed, gated batch. When the project names a reviewer, the
gate also waits for that reviewer to approve the exact patch (see
[`review`](#review) below).

Clankie's core queue landing gates rerun each failed Vitest file once in
isolation on the same composed tree before isolating batch members. The first attempt completes its
original selection. The entire isolated retry pass has a five-minute deadline;
a timeout kills the Vitest runner, blocks the gate and retains the failed rerun
receipt and log. The enclosing heavy permit drains leftover forks. Recovery
requires complete accounted results and every rerun passing. As in release,
more than two recovered files blocks the gate. Non-test failures,
repeated failures, interruptions and changed sources still block. The gate log
and `.data/qa/landing-check-summary.md` list each failed file with its exact
failed cases. `status UUID` includes `repos[].gate.testRecovery` with
the flaky files, first failure and rerun receipts. The direct root gate uses
this policy only with `pnpm check:landing --retry-failed-tests`. An app
`check:landing` receives the same flag only when the composed app tree's
`package.json` declares `clankie.landingGate.retryFailedTests: true`; the app
gate then applies its own per-package equivalent (VUH-2166).

```bash
clankie integrate CORE_SHA... [--app APP_SHA]... [--push] [--id UUID] [--no-wait]
clankie integrate status [UUID] [--wait]
clankie integrate push UUID
clankie integrate cancel UUID --actor NAME --reason TEXT
clankie integrate revert PASSED_BATCH_UUID [--push]
clankie integrate holds
clankie integrate hold --holder NAME --reason TEXT --minutes 1-60 [--pane ID|--seat ID] [--id UUID]
clankie integrate release UUID --actor NAME --reason TEXT
```

To use the queue, push a branch and run `clankie integrate <sha>... --push` as a
harness background task; it blocks until the request settles. For a request
already submitted, `clankie integrate status UUID --wait` blocks through queueing,
gating, isolation and pushing and returns its actual terminal result. `--wait`
requires a UUID; without it status remains an immediate snapshot. Existing
per-request transport timeouts and terminal held/failed/cancelled/interrupted
results are preserved; waiting never resubmits or cancels the request. Composition cherry-picks exactly the listed
commits, oldest first, so a request lists every unlanded commit of its change.
`run` refuses a request whose listed commits build on an unlanded commit that is
neither listed earlier nor in a request already queued ahead; the refusal names the
missing commits and prints the complete command (VUH-2745). Commits already on
`main` by patch, such as an earlier slice landed by cherry-pick, count as landed. With no UUID, status shows running batches, waiting
requests, the last result and interrupted work. `status UUID` reads a request
receipt, including its shared batch and attempts. `progress` shows the isolation
chain, scheduled batch position and a conditional completion ETA from recent
completed gates (`null` until measurements exist). `/integrate` displays the chain
and ETA in the TUI.

Review applies to the exact composed patch. The owning service reads the source
project's reviewer setting and supplies a verdict bound to the batch's base,
HEAD and patch-id to local or linked-machine gates. Test isolation keeps its
private HOME and credentials; `CI=1` never skips batch review. Missing review
status holds the landing. Review is refreshed after checks and before pushing,
including a saved or reused pass. If composition changes the patch, that exact
composed patch needs review before it can land (ADR 0287).

Local batches hold one governed full permit across installation and landing
gates, admitted through the same FIFO queue and slots as ordinary full builds.
They leave spare full slots, light jobs, servers and simulator work available
under the normal resource guards. `fleet resources` exposes the batch as
`mergeGate` for observation; it does not reserve the machine. Gates held over
fifteen minutes also appear in `holderAlerts`. Sharing requires the updated
service and workers.

The service checks integration progress every 30 seconds. A running head without
a checkpoint for three minutes alerts the owner through the existing runtime
health route, unless its owned install/gate process is proven alive or its
bounded remote runner is active. Waiting followers do not trigger this alert.
Opening and recovery notices are durably deduplicated across service restarts;
unavailable observations retain the incident. The observer never cancels,
restarts or resubmits a batch. Inspect the named receipt with `integrate status`.

If the local install/gate runner stops without a completed phase receipt, the
batch is `interrupted`, with the phase, runner exit and retained log paths in its
reason. Signaled commands are also interrupted. Completed nonzero installs or
gates remain failures. An interruption never attests a pass. Newly accepted requests
retain exact approved commit objects and resubmit once automatically after a runner
interruption or service restart; the original UUID follows the fresh attempt.
Recovery checks remote main before any push and records an already-present
candidate without sending it again. The lead is notified. A second interruption
or an older record without recovery metadata requires review before resubmission.

`cancel UUID --actor NAME --reason TEXT` withdraws a waiting request or active
isolated retry before landing. It reads `cancelled` with who and why. An in-flight
isolated gate finishes, but its tree cannot land with a withdrawn input even if
green; surviving requests need a fresh composition and gate. The first
non-isolated gate and a landing already under way refuse cancellation.

Requests arriving during a gate coalesce into compatible batches of at most
three requests. Conflicting members roll back; failed shared gates retry members
individually at their original admission priority, before later arrivals. An
earlier repository pass is reusable only for the same exact tree, base, approved
contributions and sibling core candidate; `gateReuse` records the retained pass.
Removing a core contribution invalidates the app pass and requires a new gate.
Gate-only runs stay
separate and never land; restores remain admission-order barriers.
An ordered approved batch composes on fresh origin in independent throwaway
core/app worktrees, performs real installs and full checks with private home,
state, credentials and package stores, and records tested HEAD and exit codes
durably. It only lands a clean exact HEAD with a recorded pass. Core lands first;
app rejection retains a partial record and retries skip already landed core.
Revert creates a new commit restoring a passed tree. Deploy holds keep runtime
updates off the running service and never block landing; each lifts on its own
after its `--minutes` (at most 60) with an `expire` receipt naming the holder.
`holds` lists current holds with their `expiresAt` and the latest receipts.
The lead or owner may release anyone's hold; the receipt records holder, actor
and reason.
Requires a local source-checkout service. See [integration](integration.md) for
evidence paths, isolation limits, uncertain sends and crash recovery.

Requests admitted while the fresh service holds `queue.lock` for startup
reclamation stay queued until its proven live writer releases the lock. Their
UUID and queue order stay intact. Unknown owners and unrecoverable stale locks
remain explicit failures; do not delete locks or resubmit an uncertain request.

Integration clones keep client hooks disabled.

`clankie integrate reclaim` sweeps historical terminal batches even while another
batch is gating and reports removed paths, retained reasons, and `freedBytes`
(allocated blocks measured before removal). It also removes empty worktrees folders.
A proven live queue owner no longer blocks terminal tree reclamation. The sweep
fences durable request dependencies before deleting: `batchId`,
`isolation.rootBatchId`, prior attempts, reused gates and `interruptionRetry.batchId`.
Raw queued receipts protect a shared attempt between failure and retry admission;
recoverable interrupted requests protect their sources before startup recovery
saves a retry claim. Those old sources become disposable when the request finishes.
An unreadable or mismatched receipt defers tree cleanup rather than hiding a retry
dependency. Concurrent sweeps serialize, and per-batch locks serialize automatic
cleanup with explicit reclamation. Each writer rereads its record under that lock.

Finished passes and retry sources can shed copied download stores independently:
`isolation/{core,app}/{pnpm-store,npm-cache}`. Installs copy package contents into
`node_modules`, so neither pushing nor retrying depends on those stores. This
cache-only path preserves worktrees, private environments and records. Active
batches, aliased paths, stored logs and live process cwd remain protected; an
unknown queue owner still refuses.

Pushed batches and failed, cancelled, interrupted or conflicting attempts lose
their disposable scratch worktrees and private `isolation/` install/gate caches as soon as the queue no longer needs them.
Failed shared attempts remain while individual retries reuse them. Records,
gate logs and repository clones remain; detached commits are pinned before
`git worktree remove --force` and `git worktree prune`. Gate artifacts and dirty
scratch files do not prevent cleanup. A partially removed checkout missing its
`.git` file can be finished only when its exact private Git registration and
batch record agree. Passed, held and partial batches remain available for push.
Aliased, locked, unverified or live-process directories stay retained; incomplete
cwd observations defer cleanup. A five-minute sweep retries deferred removals.
On macOS, each fresh cwd census reads kernel vnode paths through the native
process helper, including a complete account inventory. It avoids repeated
`lsof` filesystem scans while retaining the live-process recheck before every
removal; no cwd snapshot is reused across deletions.
Restore reads a reclaimed pushed batch's retained commit store.
Recursive scratch and cache deletion runs in an awaited child process, so large
installs do not occupy the live service's filesystem threadpool. The same
ownership, retry and live-process checks still authorize each removal.

Progress alerts. The service observes an integration head every 30 seconds and
alerts after three minutes without progress or a proven active install/gate job;
the alert names the batch and last checkpoint. Read `integrate status UUID` and
its evidence: an alert does not authorize cancellation or another submission.
Opening and recovery notices survive restarts without replay, and an unavailable
observation does not prove recovery. Remote install/gate output is observed too:
three minutes without output alerts, ten minutes triggers a fresh local gate, and
a ninety-minute wall-clock limit holds even with output. The remote timeout cause
and log remain evidence; fallback never attests a remote pass, and these
deadlines stop only that request's owned transport. A request waiting behind a
proven live queue-lock writer (including startup worktree reclamation) is read by
its UUID, never resubmitted or unlocked; an unproven owner or unrecoverable stale
lock retains its actual error for review. Failed shared gates retry members at
their original admission priority, before later arrivals. A retained `gateReuse`
pass covers only its unchanged exact tree, base, approved contributions and
sibling core candidate; excluding a core member requires a new app gate, and an
origin move after reuse requires a fresh gate.

### Scratch service and relay proofs

From a source checkout, generate one private preset for both processes:

```bash
node scripts/scratch-stack.mjs .local/my-proof
# Start the two owned processes in separate panes:
clankie heavy --server -- node scripts/scratch-stack.mjs run .local/my-proof clankie
clankie heavy --server -- node scripts/scratch-stack.mjs run .local/my-proof relay
```

The preset chooses distinct free loopback service, relay and device-doorway ports,
wires `CLANKIE_CAPTAIN_URL`, `CLANKIE_CONTROL_PLANE_URL`, `CLANKIE_RELAY_PORT`
and `CLANKIE_RELAY_URL` together, and creates private state, settings, file-backed
credentials and random test bearers. Browser and Herdr connections are disabled.
The launcher uses a clean environment and the preset, so inherited live-stack
variables cannot override it. Keep the preset local; it contains scratch credentials. Stop both owned processes
after the proof. Port selection does not reserve ports across later launches:
a collision fails startup; generate a new directory and preset rather than
falling back to the installed ports.

Start the scratch relay before `scratch-stack.mjs run DIR cli pair`. Pairing
guarantees a relay, and with none healthy the launcher starts a detached one
outside `clankie heavy` that survives the proof. If that happened, stop its
process group (working directory `apps/relay` in the checkout, command
`node … apps/relay/src/index.ts`).

`CLANKIE_SCRATCH=1` enables the startup guard. Scratch/dev harnesses must set
this flag; a custom state directory or `NODE_ENV` alone does not imply a scratch
stack. Both entrypoints refuse bind or peer ports `4310`
and `4321` with `scratch_live_port_refused`, including explicitly configured
URLs. Production stacks may use custom state directories and canonical ports. Manually
configured scratch stacks must set the same peer variables as the preset;
changing just `PORT` is insufficient.

#### Room loop rollout (ADR 0291)

A service host may route Pi social text rooms into one durable loop per room and
grant with `CLANKIE_ROOM_LOOP=all` (or comma-separated `guildId:channelId`
targets). It is off when absent and grants no authority. Machine turns,
owner-audience rooms, voice and the linked main channel are unchanged. Turns of
one loop run one at a time. Keep it on a scratch service until the
[ADR 0291](adr/0291-a-room-thinks-in-one-loop.md) eval passes: the lanes eval's
`--room-loop` flag sets it for its private service.

#### Durable Pi room prototype (VUH-2574)

A service host may opt one text-room target into restart recovery with
`CLANKIE_DURABLE_PI_ROOM=guildId:channelId` (or `dm:channelId`). It is disabled
when absent and refuses a linked main conversation or native room driver. It
uses existing channel-turn POST/GET routes and delivery IDs; the setting grants
no room or machine authority. Keep it on a private scratch service until the
[rollout requirements](adr/0284-a-service-restart-pauses-one-pi-room-turn.md) pass.

Run the manual real-model proof from the checkout with an existing API credential
for the chosen model (no OAuth credential is copied):

```bash
clankie heavy --server -- node --import ./scripts/dependency-types.mjs \
  apps/clankie/scripts/prove-durable-pi-room.ts .local/durable-proof openai/gpt-5.4-mini
```

Use a new output directory. The runner generates a scratch preset, starts and
kills only its private service/tool, removes its injected API credential at the
end, and retains logs, journals and `result.json`. It does not connect to Discord;
one saved HTTP reply is the tested boundary. No live restart is part of this proof.

#### Guarded project/settings proofs (LOCAL-VUH-14)

The original preset uses an environment-only operator test bearer. Guarded
commands such as `project list` deliberately refuse it. Keep that preset and
its refusal evidence intact. For a new disposable proof that needs those commands:

```bash
node scripts/scratch-stack.mjs .local/project-proof --broker-operator
clankie heavy --server -- node scripts/scratch-stack.mjs run .local/project-proof clankie
# Wait for the private service /health, then start its matching relay:
clankie heavy --server -- node scripts/scratch-stack.mjs run .local/project-proof relay
clankie heavy -- node scripts/scratch-stack.mjs run .local/project-proof cli auto off
clankie heavy -- node scripts/scratch-stack.mjs run .local/project-proof cli project list
clankie heavy -- node scripts/scratch-stack.mjs run .local/project-proof cli model status
clankie heavy -- node scripts/scratch-stack.mjs run .local/project-proof cli auto status
clankie heavy -- node scripts/scratch-stack.mjs run .local/project-proof cli devices --json
clankie heavy -- node scripts/scratch-stack.mjs run .local/project-proof cli body status
clankie heavy -- node scripts/scratch-stack.mjs run .local/project-proof cli work status --repo "$PWD/.local/project-proof"
```

The runner starts the source CLI from the core checkout. Work-tracker commands
therefore need `--repo` with the **absolute scratch root**, as above; bare
`work status` selects the core checkout and does not prove the scratch boundary.

This separate option omits `CLANKIE_OPERATOR_TOKEN`.
The new scratch root must be empty and must not be a symlink; an existing
broker or preset is refused without overwriting it.
The service's normal
first-run bootstrap mints a fresh credential into `project-proof/credentials.json`,
inside the private scratch root, with the broker's file permissions and locking.
It never imports an existing bearer or fabricates an owner. Both services and the
source CLI consume the same clean preset; inherited operator overrides and live
targets are discarded. `NODE_ENV=test` and a private fleet-resource directory
isolate the service's resource registry and disable simulator control. All
processes still run under the real machine's `clankie heavy` governor.

Use the ordinary `auto off` setup command; a fresh service can default Auto to
on. Before seeding or pairing, retain the actual API-backed command outputs: Auto
off, selected/effective model null, no providers, projects or devices, and the
tracker/body boundary. Local files alone do not establish a protected read.
The canonical guard, normal pairing grants and revocation still apply;
environment-only and mismatched credentials remain refused. This route grants
authority over this disposable stack only, never the installed service, real
accounts, credential broker or owner identity. Stop both owned processes before
removing the entire new scratch directory, including its broker file. Never
reuse or delete another proof's original directory.

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
it. `clankie` (`captain`) also restarts `relay`, keep-awake and the Discord body.
The Discord body must restart: its live presence claim is only valid against
the service instance that issued it. `--keep relay,activity,awake` leaves those
dependents running, which a runtime update does when their code did not change;
the JSON then lists them in `kept`. The Discord bodies cannot be kept.
Stopping is different: `stop` names one service and stops only that service.

A checkout runs each service as plain Node on the package's TypeScript
entrypoint (`node --disable-sigusr1 --import scripts/dependency-types.mjs
apps/<package>/src/index.ts`, working directory the package, its
`node_modules/.bin` first on `PATH`); an installed release runs its compiled
entrypoint with its bundled Node. No pnpm, shell or tsx sits between the
launcher and the service (VUH-2393): on 2026-10-17 those wrappers held about
460 MB across the live services, and a scratch Clankie service started in
3.1–4.6 s at about 510 MB against 4.7–12.9 s and about 1,330 MB with the
wrappers. `scripts/dependency-types.mjs` strips types from the few dependencies
that publish TypeScript, which Node refuses to do under `node_modules`.
`--disable-sigusr1` keeps a signal from opening an unauthenticated inspector on
`127.0.0.1:9229`; the live service had one opened that way mid-run nine times.
The native fleet proof helper a checkout compiles is built by the update helper
before cutover and checked by the launcher before each start, so a start
compiles nothing unless its source changed.

Each service writes `~/.local/state/clankie/<service>.log`. A log past 64 MiB
(`CLANKIE_SERVICE_LOG_MAX_BYTES`) is rotated while the service keeps writing:
its newest 64 MiB is compressed to `<service>.log.1.gz` (older generations
shift to `.2.gz` and `.3.gz`, the oldest is dropped) and the live file is
truncated in place, so the service's append-only descriptor carries on at its
start. Lines written in the instant between the last copy and the truncate are
lost. Rotation runs on every [`recover`](#recover) pass, before each start, and
every ten minutes in the service, and also covers `autostart.log`. Read an
archive with `gzip -dc`.

A stop sends SIGTERM to the service's process group and waits for every process
in it, not just the recorded leader, escalating to SIGKILL for the group
after the grace (Clankie: its play shutdown deadline plus two seconds). A
stopping Clankie answers seat event polls and acknowledgments
`503 service_shutting_down`, stops keeping connections alive, closes the rest
once shutdown settles, and exits a second later even if a stray handle remains.

Local HTTP services check listeners on their configured port (`PORT` for
Clankie, `CLANKIE_RELAY_PORT` for the relay, and both `CLANKIE_ACTIVITY_PORT`
and `CLANKIE_ACTIVITY_PRODUCER_PORT` for the activity). A scratch instance on
other ports does not block them. This uses
`lsof`, supplied by macOS and required in Linux installations for this check;
if inspection fails, the launcher conservatively refuses matching unowned
processes. Named activity tunnels check their configured tunnel name. Foreign
processes are never signalled. A process counts as this runtime's service only
when it belongs to this runtime: a release `libexec/node` under the runtime
root, or a checkout's Node entrypoint (or an older launcher's
`pnpm --filter … start`) whose working directory is in the runtime. Another checkout's service or a test fixture's look-alike under a
temporary directory never blocks a stop or start (VUH-2293).

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

New service processes clear inherited pnpm lifecycle and Pi session markers, so
a restart launched from a running package script starts a fresh lifecycle.

For CPU attribution on the next planned service start, set
`CLANKIE_CPU_PROFILE_DIR` in that launcher's environment. For example, when a
restart is already planned:

```sh
CLANKIE_CPU_PROFILE_DIR="$PWD/.local/cpu-profiles" clankie restart clankie
```

The directory is created if absent; relative paths resolve against the runtime
checkout or install root. Only the Clankie service receives Node's `--cpu-prof`
flags, checkout or release alike; the launcher's fleet proof build, bridges and
launcher helpers are unaffected.
Existing `NODE_OPTIONS` remain intact. Profiling is off when the variable is
unset or empty and opens no inspector port. Node writes a uniquely named
`.cpuprofile` there when the service exits normally, including its graceful
SIGTERM shutdown; forced termination may leave no profile. Read it in Chrome
DevTools or another CPU profile viewer. Keep profiles private because stacks and
paths can contain owner context.

This variable does not instrument an already running service. Prefixing
`clankie update` with it does not forward it into the live service's update
helper: the environment must reach the actual launcher that starts the next
runtime. Arrange it with the operator for the next planned deployment; no extra
restart is required merely to prepare the setting.

### `start [service]` / `stop [service]`

`start` starts what is not running, in dependency order, and leaves a healthy
service untouched. `stop` stops in reverse dependency order. Default `all`.
Same stdout shape as restart, with `"status": "ready"` or `"stopped"` on success.
`down` remains an alias of `stop`.

While an accepted update is mid-cutover, its helper stops and restarts services
itself. `start`, `stop` and `restart` refuse until it finishes rather than race
it; `clankie update status` shows its phase. A helper no longer running holds
nothing. Crash recovery ([`recover`](#recover)) waits for it the same way.

### `autostart enable` / `autostart disable` / `autostart status`

Start Clankie when you log in, and bring launcher-owned services back after a
crash. `enable` writes the user LaunchAgent
`~/Library/LaunchAgents/bot.clankie.autostart.plist` and loads it into your
`gui` domain. launchd runs this install's launcher as `clankie recover
--autostart` at login (`RunAtLoad`) and every 30 seconds after
(`StartInterval`, no `KeepAlive`), only inside a logged-in session: a Mac
waiting at the login window starts nothing. The first run after each boot
starts Clankie in dependency order (the service, the relay and the selected
Discord body), as `clankie restart clankie` does; every later run is one
[`recover`](#recover) pass. The launcher's supervision (ADR 0055) owns the
processes; launchd only wakes it. On a release install the agent records the
`current` launcher path, so upgrades need no re-enable. It also records your
`PATH`, `XDG_CONFIG_HOME`, and `XDG_STATE_HOME` as they were when you enabled
it; run `enable` again after changing them. `enable` is idempotent (a loaded
agent is booted out first) and `disable` unloads and removes the agent, which
also turns crash recovery off.

```json
{
  "ok": true,
  "status": "enabled",
  "label": "bot.clankie.autostart",
  "plist": "/Users/me/Library/LaunchAgents/bot.clankie.autostart.plist",
  "loaded": true,
  "command": ["/Users/me/.local/share/clankie/current/bin/clankie", "recover", "--autostart"],
  "log": "/Users/me/.local/state/clankie/autostart.log"
}
```

`status` is `enabled`, `disabled`, or `stale`: the agent file and launchd
disagree, or the file was written by an older install (a one-shot login
restart with no crash recovery). Run `enable` to repair either. The job's own
output lands in `log`; the services keep their usual per-process logs.

A checkout's agent runs its launcher under Node, and launchd's bare environment
has none on `PATH`. `enable` records a link on your `PATH` that resolves to the
running Node, such as Homebrew's `/opt/homebrew/bin/node`, rather than the
versioned binary behind it (`/opt/homebrew/Cellar/node/26.7.0/bin/node`), which
`brew upgrade node` deletes and with it every later login start and crash
recovery (VUH-2393). With no such link it records the running binary.
`clankie doctor` reports the agent's Node as `autostart` (`node`, `executable`,
and `stable` when a link exists for a pinned versioned binary) and names
`clankie autostart enable` as the fix when the Node is gone or pinned.

<a id="recover"></a>

### `recover [--autostart]`

One crash-recovery pass. A launcher start records each service's pid and only
a deliberate stop removes that record, so a record whose process is gone is a
service that exited on its own. `recover` restarts it through the usual
dependency-ordered restart (restarting `clankie` also restarts the relay and the
Discord body) and prints what it did as JSON. It never fights intent: a
deliberate `stop` has already removed the record, an accepted update that is
mid-cutover owns the services (`"skipped": "update"`), and another `start`,
`stop`, `restart` or recovery holding the service lock is left alone
(`"skipped": "busy"`). `start`, `stop` and `restart` wait for that lock rather
than race each other.

A live process can be just as gone: wedged, it answers nothing and never exits.
For the services whose probe asks the process itself over loopback (the
service's `/health`, the relay's and the lab body's `/health`, the activity
viewer), each pass also probes the live recorded process with a 5-second
budget. One that keeps failing for three minutes across at least four probes is
restarted like a crash (VUH-2393); its crash entry has `cause: "unhealthy"` and a
`reason` such as `health probe unreachable for 182 s (4 probes) while the
process was alive`, which `status`, `doctor` and the owner notice show in place
of a log line. A gap of more than two minutes between failed probes (the Mac
slept, passes were skipped) starts the count again, and a healthy answer clears
it. The Discord bridge, tunnel and keep-awake are not probed this way: their
probes cannot see a hang, or also fail when the internet does.

A crash loop backs off: restart attempts within 30 minutes wait 0 s, 30 s,
2 min, then 5 min, and a restart that dies before it is healthy counts as
another crash. After five crashes in 30 minutes recovery gives up and leaves
the service stopped. `clankie status` (`recovery`) and `clankie doctor`
(`serviceRecovery`, and its one-line summary) show each service that crashed in
the last day: `recovered`, `retrying` or `gave_up`, with the crash count and
the error line from the end of its log. A give-up raises one macOS notification,
since Clankie himself is down. A deliberate `start`, `stop` or `restart` clears
the backoff and the give-up.

Whenever Clankie starts after a crash, he tells you once through his
runtime-health alert: which service crashed, when, and the last error.
`~/.local/state/clankie/<service>-recovery.json` keeps the history (with the
tail of the log at each crash); `<service>-recovery-alerted.json` marks what he
has already reported. Linux has no autostart agent yet: run `clankie recover`
from a systemd user timer (or cron) every 30 seconds for the same behaviour.

<a id="awake"></a>

### `awake [status|on|off]`

Keep this Mac awake while it is plugged in, so Discord and the app stay reachable
([always-on guide](always-on.md), [ADR 0203](adr/0203-clankie-keeps-what-better-models-cannot-absorb.md)).
A self-hosted Mac does this by default; `host.keepAwake` unset means on there and
off on Linux or a Mac that only reaches a hosted Clankie (VUH-2393).
`on` and `off` store the choice through the revision-fenced owner host-settings
API, which reports the effective value; a stored choice always wins over the
default. `on` starts a launcher-supervised `caffeinate -s` now; `off` stops it.
macOS holds a `-s` assertion only on AC power, so unplugging lets the Mac sleep as
its own settings say. The choice survives a restart: the launcher restarts
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

On a self-hosted Mac, `--local-companion` writes a single-use offer to the
owner-private `~/.clankie/companion/companion-offer.json` (`CLANKIE_STATE`
overrides the root), for the locally installed companion to redeem. Output
contains only the handoff path. Re-running it reuses the active companion's
device identity; it cannot be combined with review offers. See
[the local companion handoff](local-companion.md) for the typed API and security
contract. Signed app distribution and the installer's call remain separate work.
Only an app trusted with [`companion trust`](#companion) can redeem the handoff.

### `companion`

```bash
clankie companion trust /Applications/Clankie.app [--label TEXT]
clankie companion list
clankie companion remove ID
```

Chooses which apps on this Mac may take the same-Mac companion handoff
([ADR 0204, VUH-2604](adr/0204-a-self-hosted-mac-pairs-the-app-directly.md)).
`trust` checks the app's signature strictly. It then records its designated
requirement (team and bundle id for a Developer ID build, the exact code hash for
an ad-hoc or development build) and prints the trusted list. The service runs
these checks against the process that actually connects, so a different
bundle, or a rebuild claiming the same bundle id, is refused. The list starts
empty and refuses every app. It is a machine setting, never moved by a
transfer. The route is `POST /v1/pairing/local/trusted-apps`, operator bearer
over native loopback only.

Public-gateway pairing uses a secure QR or full pasted link; the encryption
credential is in its fragment. Short codes are for direct private connections.
An ordinary offer also returns `localCode`, the offer's own short code, even when
`code` is the gateway link; human output shows it as `On this Mac code` for the
Mac app's **On this Mac** pairing. Only the authenticated operator's offer
response carries it, and review offers never do.
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
  "localCode": "ABCD-EFGH",
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

### Automated pairing runs

Run proof captures, simulator automation, tests and gateway probes inside a pairing
run, for example:

```sh
clankie heavy -- clankie pair --run capture-unique-id --purpose simulator --ttl 900 -- node capture.mjs
```

The child receives `CLANKIE_PAIRING_CODE`, `CLANKIE_PAIRING_URL` and
`CLANKIE_PAIRING_RUN_ID`. The wrapper revokes its run's pending and active
pairings and cancels unused offers when the child exits, including a failure or
interrupt. Use a unique run ID for each invocation. If the wrapper dies, the
fixed TTL (default 15 minutes, allowed 1–60 minutes) denies access and the service
records revocation automatically. These pairings are explicitly marked; ordinary
owner devices never qualify for automatic revocation. Do not use a real device's
pairing for a proof run.

For a runner that owns its lifecycle, `pair --run ID --purpose proof --ttl 900
--json` mints the marked offer. Always call `clankie devices end-run ID` from its
`finally` teardown. Run metadata cannot combine with review or local companion.
The API equivalent is `POST /v1/pairing/offer` with a `run` object and
`POST /v1/pairing/runs/ID/end` under the same operator identity.

`GET /v1/devices?grouped=true` groups shared push registrations into a row with
`pairingIds` and the latest `lastSeenAt`. Grouping never mutates access. Each ID
can be revoked through the existing device revoke API. Devices without a shared
registration stay separate even if their names match.

### `devices [--grouped] [--json]`

Pass `--grouped` to read the same shared-registration rows as Settings, with
`pairingIds` in JSON. The default retains every individual registration.

List paired devices. Human mode is a table whose `SOURCE` column reads `review`
for devices paired through a review offer (revoke those after the review) and
the run purpose for automation, and `pair` otherwise; `--json` is `{ "ok": true, "devices": [ … ] }` with
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

### `linear graphql --json-stdin`

Run one Linear GraphQL query or mutation through the operator tool bank as the
connected Clankie app (`linear_graphql`, [ADR 0243](adr/0243-linear-graphql-is-the-tracker-escape-hatch.md)).
Input is `{ query, variables?, operationName?, confirm? }`. Use it for what the
curated `linear_*` tools lack, such as documents or archiving. Destructive
mutations (`*Delete`, `*Archive`, `*Suspend`, `*Revoke`, `*Purge`, `*Trash`) need
`confirm` listing exactly their target ids. A mutation is sent once; after an
uncertain result, read the target before any retry. Output includes the tool
result and `ok`; GraphQL errors set `ok: false` and exit nonzero.

```sh
printf '%s' '{"query":"mutation($id:String!){documentDelete(id:$id){success}}","variables":{"id":"DOC-UUID"},"confirm":["DOC-UUID"]}' \
  | clankie linear graphql --json-stdin
```

`clankie doctor` checks the same CLI operator lane's connected catalog and the
local credential audience. `linearGraphql.usable: true` has
`scope: "operator_connected_catalog"`: the tool is exposed there; it does not
prove a provider query succeeded or that a worker or project lead has that grant.
An unavailable catalog or lane credential reports `usable: false` with a reason.
The app account fields identify the configured credential, not a fresh viewer query.
It needs the Linear API app (`linear-api`) or a workspace app connected as `linear`;
the MCP OAuth token cannot call Linear's GraphQL API.

### `linear budget`

`clankie linear budget` reads `/v1/linear/request-budget` without calling Linear.
It reports each connected actor's actual HTTP attempts in the last hour across
MCP, the API tracker, pagination, and worker publishing. The same workspace and
actor share one budget across OAuth audiences. Counters reset on service restart;
provider remaining/reset headers account for usage by other clients after the
next provider response. No credentials or request bodies appear in the report.

At 50% of the 5,000-request hourly budget, Clankie shows `warning` in `/doctor`
and submits one warning through native runtime alerts. A refused, thrown or
rejected admission remains pending and retries after 60 seconds, including when
provider requests stop or the hard budget refuses them. Only one admission can
be in flight per actor. Native acceptance stops retries even if its original
receipt is unconfirmed; acceptance does not prove the recipient read the alert.
Boot-time warnings await the native handler's result. At 80%, device Work refreshes
and explicitly marked background reads
share a one-minute minimum interval per actor; excess calls are refused before
dispatch with a retry time. Existing issue-list caching continues to apply.
Ordinary owner/lead reads, writes and webhook context reads retain priority. Every request remains subject
to the hard budget, which leaves one request below the cap. Provider headers can
lower the effective limit. The warning rearms after usage falls below 50%.
`doctor --json` and `/doctor json` include `linearRequestBudget`; unavailable
observations remain explicit. These fixed limits need no owner setup.

### `linear read TOOL --json-stdin [--background]`

Read through the connected Linear tool bank using JSON arguments on stdin.
Use `--background` for automated polling; owner reads default to interactive
priority. Reads and GraphQL dispatch through `mcp_tool_call`, so deferred tools
are reachable without adding their schemas to the initial tool list. A missing
tool returns a typed `lane_tool_unavailable` or `project_grant_tool_denied`
refusal with the lane and service readiness; it never expands the grant.
The fleet equivalent is `clankie_call({name, arguments, background: true})`.
Background markers do not grant authority or downgrade writes. Each logical
read gets its own admission and may finish its provider pages. For example:

```sh
printf '%s' '{"team":"VUH"}' | clankie linear read list_issues --json-stdin --background
```

For project updates, use `get_status_updates` with
`{"type":"project","project":"PROJECT-UUID","limit":1}` (`project`, not
`projectId`). In an admitted native connected bridge, discover schemas with
`mcp_tool_search({names:["linear_get_status_updates","linear_save_status_update"]})`
and call `mcp_tool_call({name:"linear_get_status_updates",arguments:{type:"project",project:"PROJECT-UUID",limit:1}})`.
Fleet workers use `clankie_tools` and `clankie_call` with the same qualified names.
Creation uses `linear_save_status_update` with `{type:"project",project,body,health?}`;
`health` is `onTrack`, `atRisk` or `offTrack`. Replacement adds `id` and replaces
the complete body, so read first. These are connected Clankie routes; project
fences and room mutation refusals remain in force. Arbitrary GraphQL stays
unavailable to a project-fenced lead.

Initial account setup and OAuth token endpoint calls are outside the connected
Linear request counter; GraphQL identity verification during a connected app's
credential refresh is counted.

### `linear status` / `linear follow on|off`

A verified Linear webhook stores a compact **External activity** message in its
selected ordinary Clankie chat. `linearWebhook.projectChats` maps verified project
UUIDs to existing lead chats. Unconfigured projects and removed lead chats go to
`global-default` with the project named. Nonproject activity uses
`linearWebhook.wakeConversationId`, default `global-default`. Open it with
`clankie --chat global-default`, or use the configured ID. A chat named for Linear
has the same conversation controls and history as any other chat.

Following is off by default. With following on, a new signed event that passes
`linearWebhook.wake` wakes this chat. The lead decides what to do and delegates
from there. Events arriving within a 1.5-second burst window coalesce into one
wake containing issue identifiers and titles,
what changed, who acted, and links. Events that do not pass the rules remain
visible as external context without starting a turn. Exact own-write echoes are
suppressed; Clankie's connected account and attributed workers never wake him.
Unknown or ambiguous actors stay quiet. Production wakes also require the
connected Linear account identity to match the signed event's workspace. An
unavailable identity or workspace mismatch keeps activity passive, logged as
`identity_unavailable` or `account_workspace_mismatch`; local `active` readiness
alone does not prove this identity lookup succeeded. Signed webhooks drive wakes;
the separate inbox and issue-owner routing are retired.

After a wake arrives, its target chat confirms the host-issued original ID through
`linear_wake({ action: "received", wakeId: "seat-…" })`. The tool derives the chat
from its current host authority and verifies the original native recipient and
fingerprint. A different chat, replaced occupant or untaken wake cannot confirm
it. A native transport ACK alone leaves provider notifications unread.
Only unique signed notification matches for events included in the received batch
are marked read. Comment UUID anchors permit delayed inbox creation; ambiguous
matches remain unread. Read claims persist before mutation. Uncertain writes are
held and settle through read-only observation, without replaying the mutation.
The shared background request budget applies to bounded scans and the ten-minute
delayed-notification retry window, including service reload.

A Comment webhook may carry only `issueId`, without an issue title. Missing
display context is filled from retained signed Issue history or a native
connected `get_issue` lookup bounded to one second. Its exact project UUID/name
can select a configured lead chat. Sparse project-update comments resolve only
their signed parent update UUID through `get_status_updates`. URL slugs do not
prove project identity. These reads supply context; signed
actor, resource and changes remain the authority for wake rules. If title lookup
is unavailable, the compact event says `Title unavailable` and keeps its signed
issue UUID and link rather than dropping the event.

### `linear routes show|set --json-stdin` / `linear deliveries`

`clankie linear routes show` lists project destinations. Replace the array through
`linear routes set --json-stdin`, or use `linear_wake({ action: "set", projectChats: […] })`.
Each entry is `{ projectId: "full UUID", name: "Project name", conversationId: "existing global chat ID" }`.
Duplicate projects or missing/worker chats are refused. `/linear` → **Project lead chats**
edits one entry. No live app registration changes are needed.

This explicit project lead binding also supplies the conversation's project
when it hires into that project's registered workspace, even if the conversation
uses another folder. The UUID must match the project's built-in tracker or
Linear binding. A lead owning several projects names `projectId`; its destination
and existing native admission checks still apply.

`GET/PUT /v1/linear/routes` reads/replaces `{ projectChats }` with operator
authentication. `clankie linear deliveries` reads `GET /v1/linear/deliveries`:
offered wake ID, conversation ID, included event IDs/projects/routes, native
original receipt, and `receivedAt` when the target confirms. An offered batch
can have failed before delivery; `offeredAt` is not a consumption receipt.
The response also includes `recoveries`: missing-receiver holds, pending event
IDs and source resolutions (`rerouted` or `already_handled`, with destination
and timestamp). Retained unread activity is resolved against current routes
before admission, including on upgrade/restart. An unavailable lead falls back
to `global-default`; if that receiver is absent too, the activity stays queued.
One notice appears in the default lead chat. New bursts/restarts perform one
preflight; a returning native poll resumes delivery. No blind retry timer creates
failed turns. Unavailable nondefault chats show `(inactive)` while keeping their
history; a returning receiver restores an unedited title. An uncertain original
is never automatically rerouted or resent.
Native originals retain the exact recipient binding, or the host-synchronized
`recipientSessionKey` when no fleet binding exists. The target's `linear_wake`
`received` call must match that saved identity and the original outbox ID and
fingerprint. A changed session or an old original with neither identity is
refused; transport acknowledgment alone never marks notifications read.

| Following     | Chat history                   | Automatic model turns                  |
| ------------- | ------------------------------ | -------------------------------------- |
| Off (default) | Accepted events remain visible | None from incoming events              |
| On            | Accepted events remain visible | One coalesced wake for eligible events |

The default rules wake only for comments or mentions by the owner, identified by
a signed Linear user ID or email in `ownerUserIds` / `ownerUserEmails`. Both
start empty, so a new install wakes on nothing until the owner sets one; while
following is on, `clankie linear status` and `clankie doctor` warn about the
missing owner identity. Other actors and other changes stay quiet. The connected tracker account remains Clankie's and his fleet's publishing
identity; it does not become the human owner. Display names and notification
subtitles do not prove authorship. A wake supplies context, never new permission.
[ADR 0214](adr/0214-linear-wakes-require-attribution-and-rules.md) records the
attribution and routing decision.

`clankie linear follow on|off` applies live. Turning it off suppresses new and
queued event turns; an already-running turn can finish. Turning it on does not
replay events that were skipped while it was off. `clankie linear status` reports `following`, `active`,
`webhookConfigured`, `reason`, `missingWebhook`, `detail`, `wakeConversationId`,
`wakeWarning`, and `settingsFile`. Following requires both the registered webhook
URL and its broker-held signing secret. Enabling without them leaves the switch
unchanged, returns `ok: false`, `error: "linear_webhook_required"`, and exits
nonzero. `missingWebhook` names `url`, `secret`, or both. If a prerequisite is
removed after enabling, status reports `following: true`, `active: false`, and
the same reason. Turning following off remains available.

Configure the webhook from `/connect linear` → **Follow Linear** → **Configure
webhook**. The flow stores the registered public URL in `linearWebhook.url` and
the signing secret in the credential broker (`linear-webhook`). Select all
available activity events in Linear's webhook settings. Setup does not enable
following; **Start following** / **Stop following** is separate. Existing setups
that stored only a secret can record their registered URL with
`clankie linear webhook set --url URL`. `clankie linear webhook clear` removes the
stored URL and leaves requested following visibly blocked. The secret remains
broker-owned and is never a CLI flag. Readiness checks local configuration,
not delivery health or the webhook's current status in Linear.

The signed public ingress remains `POST /v1/hooks/linear`. It verifies the raw
body's signature and timestamp before parsing, deduplicates accepted deliveries,
and retains replay safety across restart. The consumer accepts signed `create`,
`update`, and `remove` activity. A matching revision of Clankie's own MCP write is
dropped at ingress; delegated worker events retain their provenance but stay
quiet. For issue write receipts, display-label `id` values such as `VUH-1641`
require a valid returned `uuid`; UUID-valued `id` is also accepted. Conflicting
or missing identity proof never suppresses an event. Workspace, actor, resource,
revision time, and saved-field matching still apply to exact echoes.

The old `linear-inbox` conversation and notification checkpoint are retired.
On upgrade, retained unread inbox activity is dropped once with a service log
entry; it is not replayed into a fresh wake. Historical records in Linear remain
available through Clankie's connected `linear_*` tools.

The authenticated local operator API exposes `GET /v1/linear/follow` and
`POST /v1/linear/follow` (or the local PUT alias) with
`{ "expectedRevision": "<revision from GET>", "following": true | false }`.
Both report a revision and the configured `wakeConversationId`; a stale revision
or missing webhook prerequisites returns 409. The device relay admits GET/POST.
Changing the local switch does not change which events Linear sends.

An unavailable native receiver leaves matched activity pending. Its next poll
retries the compact wake without starting a second lead in the service. Confirmed
or uncertain native takes are never replayed. Following off suppresses pending
wakes. `linear.webhook` receipts in the service log record admission and the rule
decision; the chat's subsequent turn and native receipt establish delivery.
These receipts are not written to the domain event journal.

#### `linear target show|set CONVERSATION_ID`

```sh
clankie linear target show
clankie linear target set global-default
```

The target is one non-secret setting, `linearWebhook.wakeConversationId`. Select
an existing ordinary global chat, or a workspace project lead chat, the owner can open; an attached native operator
seat can drive it. To use a new chat, create it with `/new` in the TUI, name it
Linear, and find its stable ID with `clankie conversations list` before setting
the target. `set` does not create a chat. The change applies live to new activity;
it does not move history or replay earlier events. The authenticated
API is `GET /v1/linear/target` and `PUT /v1/linear/target` with
`{ "conversationId": "global-default" }`.

Private operator leads see the global lead and configured project leads in the
session card and `get_self_state.leadChats`. Each row names its project,
conversation, workspace, machine, holder, receiver state, activity time and
`messageSeat` target. `messageAvailable` reflects a current native receiver or an available local service lane;
stale, reconnecting and disconnected native heads are shown explicitly.
Activity timestamps describe recorded activity, not proof of a live receiver.
Worker and room chats are excluded, and Discord never receives this roster.

Use `message_seat` with the row's conversation ID to contact another lead.
The existing lead channel carries attributed agent context and a delivery
receipt; it never adopts that lead or types into its pane. With no native channel,
a local service lead durably queues the message and wakes in its own conversation.
`status: lead_service_queued`, `state: queued`, and `deliveryStage: stored` mean inbox
acceptance, not native acknowledgment or lead review. Use `reconcile_seat_call`
with the returned message ID (or MCP dispatch ID) to read its progress, including
after restart. Remote-only leads still require their native bridge; uncertain
native sends retain their original receipt and never fall back to a second send.

The owner's paired devices read the same projection with encrypted dispatch
`POST /operator/v1/dispatch`, body `{ "op": "lead_chats", "schemaVersion": 1 }`.
Hosted devices use their existing `/v1/hosted/operator` wrapper. The protocol
client exposes optional `leadChats()`; existing operations and old devices are
unchanged. The response has `op: "lead_chats"`, `schemaVersion: 1` and `result`:

```json
{ "outcome": "ready", "chats": [] }
```

Each chat has `conversationId`, `title`, `projects: [{id, name}]`, `workspace`,
`machine`, `holder` (`{kind: "native", seatId, harness}` or
`{kind: "service", lane: "operator"}`), `state` (`current`, `stale`,
`reconnecting`, `disconnected` or `service`), `activity` (`unbound`, `active`,
`waiting`, `completed` or `failed`), `lastActiveAt`, optional `lastBridgeSeenAt`,
`messageSeat` and `messageAvailable`. These fields follow `LeadChatSchema` in
`@clankie/protocol`. An unavailable observation returns
`{outcome: "unavailable", message}`; it is distinct from an empty ready roster.

Only active owner-paired devices with `terminalControl` can read it. Hosted
visitor, guest and support devices are refused, as are operator/captain bearer
tokens and Discord. Denial is HTTP 403 `{error: "owner_device_required"}`.
Device identity, grants and revocation are rechecked before releasing a read.

#### `linear wake [show|set …]`

`GET /v1/linear/wake` returns `{schemaVersion: 1, revision, wake}`.
`POST` (or the local PUT alias) accepts `{expectedRevision, wake}` and replaces
the rules. The CLI reads that snapshot and fences flag or JSON edits by its
revision. Devices use the same GET/POST route.

Bare `/linear` opens **Follow Linear**, including **Wake rules**. Rules live in
`linearWebhook.wake`. Clankie can inspect or change these non-secret settings
himself through the operator-only `linear_wake` tool or authenticated CLI;
following must still be active.

```sh
clankie linear wake show
clankie linear wake set --owner-user-emails owner@example.com --actors owner
clankie linear wake set --types issueNewComment,issueCommentMention,issueMention
clankie linear wake set --exclude-types issueSubscribed
```

`set` flags patch only the specified fields. Lists are comma-separated; `none`
clears one. `--json-stdin` replaces the whole rule object with defaults for
omitted fields. Malformed rules fail without writing. The result contains `ok`,
`wake`, and `settingsFile`.

| Flag                  | JSON field                  | Meaning / default                                         |
| --------------------- | --------------------------- | --------------------------------------------------------- |
| `--owner-user-ids`    | `ownerUserIds`              | Additional explicit owner Linear IDs; initially empty     |
| `--owner-user-emails` | `ownerUserEmails`           | Signed owner user emails; initially empty                 |
| `--actors`            | `actors`                    | Any of `owner`, `human`, `self`, `users`; default `owner` |
| `--user-ids`          | `userIds`                   | Exact IDs selected by `users`; initially empty            |
| `--types`             | `notificationTypes`         | Included activity types; empty allows all                 |
| `--exclude-types`     | `excludedNotificationTypes` | Exclusions always win; default `issueSubscribed`          |

The default included types are `issueNewComment`, `issueCommentMention`,
`issueMention`, `issueAssignedToYou`, `issueCommentReaction`,
`projectUpdateNewComment`, `projectUpdateMention`,
`initiativeUpdateNewComment`, `initiativeUpdateMention`, `documentNewComment`,
and `documentMention`. The existing VUH-1549 rule engine classifies signed
webhook activity using these types. A newly added Linear issue/profile/resource
link in signed `body`, `description`, or `content` counts as a mention.
Signed `Issue.assigneeId` and `Issue.delegateId` changes count as
`issueAssignedToYou` only for assignment/delegation to the connected app actor.
A signed `Reaction` create counts as `issueCommentReaction` only when its
embedded comment author or retained exact comment write proves that actor.
Enable the `Issue`, `Comment`, and `Reaction` data-change webhook categories.
The separate `AppUserNotification` and `AgentSessionEvent` webhook envelopes are
not consumed by this data-change receiver; full Linear agent-session lifecycle
support remains separate from waking the chat on delegation.

Legacy owner-only filters migrate to the new comment/mention defaults when
`ownerUserEmails` is absent and the saved filters match the old defaults:
`actors: ["owner"]`, `userIds: []`, `notificationTypes: []`, and
`excludedNotificationTypes: ["issueSubscribed"]`. Configured `ownerUserIds` are
preserved as identity setup. Edited selectors, included types, or exclusions
remain unchanged. Once `ownerUserEmails` is persisted, an intentionally empty
`notificationTypes` list remains all-types; `clankie linear wake set --types none`
can select that behavior after upgrade.

`owner` requires a signed human actor matching an owner ID or email. `human`
requires signed user identity and excludes the connected account and workers.
`users` matches exact IDs. Selectors are ORed, but own-write suppression remains
in force. Find Linear IDs through the connected `linear_get_user` tool rather
than inferring them from a name or an app account.

The operator-only `linear_wake({ action: "show" })` returns the rules and target.
`linear_wake({ action: "set", wake: {…}, conversationId: "global-default" })`
patches the supplied rule fields and optionally changes the target. No secret
or owner-console wizard is needed for these settings.

`GET /v1/linear/wake` returns `{ "schemaVersion": 1, "wake": {…} }`.
`PUT /v1/linear/wake` replaces the rule object, filling omitted fields with
schema defaults. Both require the operator bearer; invalid rules return 400.
API, CLI, tool, and TUI edits apply to the next event without restart. They
never promote old passive history. Use `follow off` to stop queued turns.

Clankie's worker and operator Claude plugins also deny inherited Linear MCP
tools in hand-started plugin sessions, even without a live bridge. Their visible
startup notice directs evidence to `clankie_tools` / `clankie_call`; an unlinked
worker asks its lead to post. Plain Claude sessions without these plugins keep
the owner's personal connector. To enter the operator boundary reversibly, use
`clankie claude`; exit it and launch plain `claude` to use the personal session.
No profile configuration changes. See [tracker identity](worker-tracker-identity.md)
for the limit of signed user-actor provenance and plugin update requirements.

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

`accounts codex list` and `accounts claude list` read the same discovered identity
list as `accounts workers`, `usage` and app Settings. Standard `~/.claude`,
`~/.claude-*`, `~/.codex-*` homes (Codex needs `config.toml`), the harness's
selected environment home, and registered extra homes are discovered together.
Each canonical home is queried once. Native `claude auth status` and Codex
`account/read` (`refreshToken:false`) supply non-secret identity and plan fields.
No credential file is read, copied or moved by Clankie's account discovery.

Homes signed into the same account/org ID (email when no native ID is available)
share one stable `accountKey` and `label`, one usage card and one hold. Cards
show the signed-in name or email. `homes` lists that account's current homes;
`profiles` in the CLI response lists manual discovery overrides separately.

```sh
clankie accounts codex list
clankie accounts claude list
clankie accounts codex add /existing/custom-home --label work
clankie accounts codex remove work
```

Registration is an optional path override; removing it never deletes a home or
changes sign-in. Existing profile aliases bind to the first discovered identity,
so re-signing a folder cannot redirect saved hire preferences or usage history.
Clankie records one clear notice for each observed re-sign. Use the identity key
from the account list to choose a different account deliberately.

### `accounts workers [--machine ID]` / `accounts hold|release claude|codex|pi LABEL [--machine ID] [--reason TEXT]`

`accounts workers` asks a machine which worker accounts it can hire on now
(`GET /v1/worker-accounts?fleet=ID`, operator credential; omit the machine for
this Mac's registered profiles). Each Claude profile and Codex account reports
its label, home, `signedIn`, identity (email) and plan as its own CLI states
them (`claude auth status`; Codex's app-server `account/read` and
`account/rateLimits/read`), Codex `headroom`, whether Clankie's worker plugin is
in each Claude profile, any owner hold, and `usable` or the `reason` with its
fix. Tokens are never returned. Pi inspection reads its native profile without
refreshing or changing credentials. Prime Agent's providers on this Mac are
listed too, as described under `usage`; they are never `usable` here because a
Prime seat picks its own provider, and they cannot be held. Each Claude and Codex account also carries
`usage`: its windows (percent used, length, reset) with their source and
observation time, read from the profile's own `claude -p /usage` or Codex's
rate limits ([ADR 0260](adr/0260-usage-meters-come-from-each-harness.md)).
`headroom` is the tightest account-wide window; unobserved usage stays `null`.
Claude profiles also report `tier`, the plan's rate-limit tier Claude Code
caches for that same sign-in (for example `default_claude_max_20x`); a cache
for a different email is ignored. A signed-in Claude profile whose first-run
setup (theme, security notes, folder trust) is unfinished is not `usable`: a
hire there would stall at those screens with `start_unconfirmed`. Its `reason`
names the one-time fix, opening Claude once in that profile.

A machine with no `claude` or `codex` command on its PATH reports that harness
under `unavailable` as not installed, with its install command, sign-in and
plugin step (`clankie harness install` on this Mac, `clankie herdr prepare NAME`
on a linked machine), rather than probing its homes (VUH-2625). This Mac's probe
runs on the owner's `node` and falls back to the service's own, so a release on
a Mac with no Node on PATH still answers. A linked machine with no Node, or no
link, reports that it did not answer the probe. When the first hire in `/setup`
finds no usable harness, `/setup` repeats these reasons.

The report's `allocation` ranks each harness's accounts for automatic hires
(VUH-1974). Each eligible (usable, unheld) account gets its spare capacity per
day: plan weight × (fraction left ÷ days until that window resets − share used
per day so far), at its tightest all-model window. Plan weights are relative to
each harness's base paid plan: Claude Pro 0.2, Max 5x 1, Max 20x 4; Codex Plus
1, Pro 6. An unreported tier counts as 1 and says so. Pace is a window's own
average, measured once 5% of it has passed; a window with no reset counts as a
whole window away. Model-scoped windows (`week:<scope>`, such as Codex's
gpt-reserve) bound only hires on that model, so they are named in the reason
but never rank. Unknown usage ranks after every reading. `runsOut` lists any
window on pace to run out before its reset, and `recommendations` says where
the next automatic hire on each harness goes and why. Hires that leave the
account open, locally and on linked machines, take rank 1; the hire result's
`accountChoice` states the harness and account chosen and the reason. Explicit
accounts (request, role or fleet) and owner holds always win.

The local Pi `default` profile uses the same report and holds. It is usable only
when the native adapter is enabled, its pinned files and executable verify, and
the worker has a configured authenticated model. Managed bodies derive that
model from their existing included/customer provider route; no owner account
setup is needed. On owner-run bodies, the opt-in is
`CLANKIE_PI_NATIVE_ENABLED=1` in the service environment, followed by an
owner-authorized service restart, for example
`CLANKIE_PI_NATIVE_ENABLED=1 clankie restart`; the disabled report names that
step. A service started later without the variable, such as by autostart, runs
with Pi disabled again. There is no setting or `clankie pi` command for it.
Other values leave native Pi disabled. The
local profile is separate from Clankie’s service credentials: its selected model
must be available and authenticated. The report distinguishes a missing default,
an unavailable model, missing authentication and expired OAuth. Refresh expired
credentials in native Pi; inspection never does it for the owner. Unknown or
unavailable capability fails closed. Pi is the
automatic fallback after eligible Claude/Codex accounts, within the requested
model constraints; a local Pi observation never qualifies a remote machine.

`accounts hold` sets an account aside from Clankie's automatic choice, for
example a plan that will not be renewed or usage saved for something else; an
explicit hire may still name it. `release` returns it. Holds live in
`workerAccountHolds`; `--machine` is a runtime connection id (or the machine it
rides) and defaults to `local`. The console's `/accounts` menu shows the same
report per machine and holds or releases an account from it.

```sh
clankie accounts workers --machine pc
clankie accounts hold codex default --reason "plan not renewed"
clankie accounts release codex default
```

A Codex home whose sign-in the vendor refuses when asked for usage (401/403) is
skipped by automatic local selection as well, and refused when named.

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

Local Codex hires that name no account take the allocation's rank 1 (see
`accounts workers`; [ADR 0261](adr/0261-hires-go-where-capacity-would-go-unused.md)). When the allocation cannot be read, they choose the
greatest minimum remaining fraction across the
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

### `huddle [list | ID] [--json]` / `huddle start [--project ID] [--window MINUTES]` / `huddle close ID`

A huddle (VUH-2025) asks every seat the asking conversation leads, in a project or
across the fleet, one question: what it is on, what blocks it, and which files it will land when.
Each seat gets the request once through its normal channel and answers at its
next pause between steps, without stopping work, by sending `message_clankie`
a single JSON block:

```json
{
  "huddle": "hud_…",
  "on": "…",
  "blocked": null,
  "blockerUrgent": false,
  "landing": { "files": ["apps/…"], "etaMinutes": 40, "repo": "optional" }
}
```

That answer is recorded on the huddle rather than reaching the lead one by one.
Once every asked seat has answered, or the window (default 15 minutes) passes,
the lead conversation hears one compiled board. The **landing order** lists
seats that will land something, earliest ETA first (unknown last). A seat that
touches a file an earlier seat also touches in the same repository (worktrees of
one repo count as one) lands after it, and the board names the shared files.
Another lead's hires are never asked (steer them through that lead), and heads,
the seats that lead others, lead huddles rather than answer them. **Blockers** come urgent first; the lead files those that
cost the fleet time as Urgent issues. Answers arriving later still update the
board. `close` stops collecting and compiles now. Nothing stops, moves or
steers a seat.

`huddle` prints the latest board (`--json` for the record); `huddle ID` prints
one. The console's `/huddle [start [project] | close ID | ID]` shows the same
board, and the lead calls it with the `huddle` tool. The API is
`GET`/`POST /v1/huddles` and `POST /v1/huddles/close` with `{ id }` (owner or
Take Control authority, relayed for the app). Records live in
`~/.clankie/captain/huddles.json` (the latest 32).

```sh
clankie huddle start --project clankie
clankie huddle
clankie huddle close hud_abc123def456
```

### `usage [--refresh] [--fleet [--days N | --since ISO] [--until ISO]] [--json]` / `usage overlay [on|off]` / `usage warning [on|off|HOURS]`

`usage` prints one row per registered Claude profile and Codex account: harness,
account, plan (Claude's tier as the profile last fetched it, e.g. "Max 20x"; else
the harness plan, e.g. "Pro"), and the five-hour and weekly windows as percent used
with a small bar and the reset in local time ("3pm", "Wed 6am"). Model-scoped
limits in use follow on an indented line, as does "held: …", "not signed in — …"
or why usage is unknown.

`usage --fleet --days 7` adds local native context spend beside the account meters.
`--json` includes it in `fleet`; the same owner API read is
`GET /v1/usage?fleet=1&days=7`. Each native session and UTC day reports model calls,
context tokens, median context per call, the share of tokens in calls strictly
above its budget, compactions and foreground sleep calls. Lead budget is 250K;
worker/subagent budget is 300K. This measures raw native input, including cache
reads and writes; the vendor account windows retain their own meaning.

For reproducible comparisons, use `--since ISO --until ISO` instead of `--days`.
The start is inclusive, the end exclusive; `--until` defaults to now. Days and
intervals are positive and at most 366 days. Ordinary account reads never scan
transcripts. Explicit fleet reads stream all discovered local native files so
older retained identities cannot change with the requested window, and share the
same query for one minute; `--refresh` rereads both meters and the ledger.

The fleet ledger also reports `above400KContextTokens` per seat/day for ADR 0293’s fixed worker comparison; divide its worker sum by worker `contextTokens` to measure the parent’s under-10% goal.

Claude calls are deduped by native message ID, including separate subagent
transcripts. Codex context comes from `token_count.last_token_usage.input_tokens`,
which already includes cached input; response IDs dedupe its snapshots, with
cumulative snapshot identity as the fallback for older rollouts. A retained copy
of a native message contributes once. Canonical native calls are selected before interval filtering: latest usage
timestamp wins; equal-time fragments use the largest valid context reading, then
a stable seat identity. Codex retained snapshots are reconciled with their
explicit native response IDs with valid retained usage when unambiguous. Invalid
usage cannot register an alias or discard a valid anonymous snapshot. Adjacent reads therefore use the
same canonical timestamp and UTC day as a combined read. A compaction counts only in the requested interval.

Roles come from native census and retained hire/lead-relaunch records. Historical
sessions without attribution are labeled `unknown` and use the worker review
budget; child transcripts have their own `subagent` rows. Unreadable or malformed
sources stay visible in `warnings`. Foreground sleeps count literal shell/tool
calls with `sleep`; explicit background calls and quoted mention-only commands
are excluded. The ledger reads metadata and native transcripts and takes no
fleet action. Linked machines are outside this local report.

Prime Agent's providers follow, one row each, from the kinds in Prime's
`auth.json` (`PRIME_AGENT_CODING_AGENT_DIR` or `~/.prime/agent`) and the
providers its transcripts used. An API key's row shows its spend since local
midnight and over the last seven days: the sum of each assistant message's
`usage.cost.total` and `totalTokens` in Prime's root and subagent transcripts.
That cost is Prime's own estimate at list price, not a bill. A ChatGPT/Codex
subscription (`openai-codex`) whose account is one of Clankie's Codex homes
shows that home's windows, since both draw from one pool; any other
subscription, including Claude's (Prime's sign-in does not say which account),
says its limits are unknown. A provider Prime used but has no sign-in for is
listed with its kind unknown. Only each sign-in's kind and ChatGPT account id
are read; Prime's keys and tokens are never read into the report.

```text
HARNESS  ACCOUNT       PLAN          5H                          WEEK
Claude   jamescvolpe   Max 20x         5% █░░░░░░░░░ 3pm          84% ████████░░ Wed 6am
Codex    volpestyle    Pro           —                            29% ███░░░░░░░ Oct 16 7:04am
         gpt-reserve week 94% used, resets Oct 16 5:05am
Prime    anthropic     API key       —                           —
         spent today $27.58 · 57.9M tokens; last 7 days $27.58 · 57.9M tokens (Prime's list-price estimate)
Prime    openai-codex  Subscription  —                            29% ███░░░░░░░ Oct 16 7:04am
         draws from Codex account default's limits
```

`--json` prints the raw report: identity, plan, `tier`, `headroom`, and each
usage window: its harness label (Claude's
"Current session", "Current week (all models)", model-scoped weeks; Codex's
weekly and model-scoped limits), `usedPercent`, `windowMinutes` and `resetsAt`.
`usage.source` names the reading (`claude-usage` or `codex-rate-limits`),
`usage.observedAt` when it was read and `ageSeconds` how old it is. An account
whose usage was not reported has no `usage` and a `reason`; unknown is never
shown as free quota. Prime rows (`harness: "prime"`, label = Prime's provider
id) carry `credential` (`api_key` or `subscription`; absent when unknown),
`spend` (`today` and `week`, each `{costUsd, tokens}`, source
`prime-transcripts`) for API keys, and `sharesLimitsWith: {harness, label}` with
that account's `usage` for a shared subscription. Readings come from `GET /v1/usage` (owner credential,
relayed for the app), which shares one reading per minute across every surface;
`--refresh` reads again now. No harness credential is read or returned
([ADR 0260](adr/0260-usage-meters-come-from-each-harness.md)). The report's
`allocation` is the hire ranking described under `accounts workers`; the console
prints its recommendations as "Next hire" lines.

`usage warning on|off|HOURS` sets when Clankie's lead hears that an account is
on pace to run out before its weekly reset (`usage.runOutWarning`, default on;
`usage.runOutWarningHours`, default 12, 0–168). Each fleet round with led seats
reads this Mac's accounts; a weekly window projected to run out at least that
many hours before its reset wakes each lead once per window reset, naming where
the next hires should go and suggesting a handoff at the next checkpoint.
When a warned window has a fresh reset reading or its measured pace recovers
through reset, that lead hears one "Capacity recovered" notice with used percent,
reset and observation time. Auto wakes include fresh per-account headroom, pace,
reset and observation age from the same reader. Never pause or keep pausing hires
on usage grounds without a fresh `worker_accounts` / `clankie usage --json`
reading in that turn. A near-reset projection is routing advice, not a blanket
hiring pause. Unknown and signed-out accounts are not exhausted; owner holds
still apply. Nothing is moved or stopped.

`usage overlay on|off` shows or hides the meters beside Clankie in the desktop
overlay (`usage.overlay` in settings, default on; `GET`/`POST /v1/usage/settings`,
revision-fenced). The console's `/usage` opens a live panel over the same
report: a bar per window colored by how much is used, a marker where the
current pace lands it at reset (red `▶` and "runs out ~…" when that is before
the reset), a countdown to each reset, each reading's age, and the next-hire
pick. It re-reads every 15 seconds while open; `r` reads every account again,
`o` toggles the overlay, `w` the run-out warning, and `esc` closes it. On a narrow
terminal each window takes a compact row; without color the text says
everything. The app's Usage screen shows the same report and toggles both.

```sh
clankie usage
clankie usage --refresh --json
clankie usage --fleet --days 7 --json
clankie usage --fleet --since 2026-10-18T01:40:00Z --until 2026-10-25T01:41:00Z --json
clankie usage overlay off
clankie usage warning 24
```

Register a second Claude profile with `accounts claude add HOME --label LABEL`.
For `~/.claude` itself, sign it in once with
`CLAUDE_CONFIG_DIR=~/.claude claude auth login`: Claude Code keeps a separate
sign-in for an explicitly named config directory.

### `accounts [list]` / `accounts connect PROVIDER` / `accounts disconnect PROVIDER` / `accounts apps`

The owner's own GitHub, Linear and Google accounts, linked to this body
([ADR 0232](adr/0232-hosted-connections-use-the-body-broker.md)). The
service runs each flow and keeps the token in the credential broker (`github`,
`linear-api` for registered Linear API OAuth); nothing here prints a token. `accounts` lists each provider's
`status`, account, scopes and where to manage it. The body supplies the catalog's
name, purpose, permission disclosure and read-only flag. App, account dashboard
and `/connect accounts` (also `/connections` → Accounts) use that same catalog.
Google rows can report `awaiting_consent`, `expired`, `reconnect_required`,
`unavailable` or `disconnected`, together with the last check and pending revocation.
An unconfigured row means an operator has not configured the developer OAuth client.
The `email` row is his own mailbox, with the address he sends as and the result
of the last real exchange, re-checked when older than a minute: `connected`,
`reconnect_required` with reason `sign_in_rejected` when the mail server refused
the stored password (or the Clankie account sign-in lapsed), or `unavailable`
when it could not be reached. The mailbox is his Clankie address on Clankie's
mail service ([ADR 0242](adr/0242-every-clankie-has-a-mailbox-we-run.md)), or
the owner's own IMAP/SMTP server. A hosted body has the Clankie address with no
setup. On a self-hosted install signed in to a Clankie account,
`accounts connect email` (or `/connect email` → Clankie mailbox, or the app's
Connect Email) chooses it in one step through `POST /v1/accounts/email/connect`
and returns the row. It asks the mail service first: without a Clankie account,
or when the service refuses it, it answers `account_required` (`unavailable` when
the service can't be reached) and changes nothing. `settings.email.provider` records `clankie` or `imap`, and
unset means a configured IMAP server wins; a stored IMAP password is kept for a
switch back. Sends through the Clankie
mailbox have hourly, daily and different-recipient limits; a refusal at one is
`limit_reached` and names it. `accounts disconnect email` forgets a stored IMAP
password (`revoked: false`; an app password is withdrawn at the provider) or
switches away from the Clankie address, which stays the account's.
`accounts connect github` prints the code to type at
GitHub on stderr, polls at GitHub's interval, and returns the connection.
`accounts start github` and `accounts poll github --flow-id ID` expose the same
flow as separate steps for interactive clients.
`accounts disconnect PROVIDER` revokes at the provider when it can and
always deletes the local token; `revoked: false` comes with the `manageUrl`
to revoke by hand. Disconnecting Linear clears its API and legacy MCP/app lanes
and pending flows. The app's Connections settings and the account page use the
same encrypted lifecycle. `/connections` exposes account identity, granted
scopes, connect and disconnect beside machines in the console.

`accounts connect google-gmail|google-calendar|google-drive` (or `start` with the
same provider) returns a browser consent URL, single-use state and expiry.
`accounts complete google-gmail|google-calendar|google-drive --json-stdin`
consumes `{state,code}` for Gmail/Calendar or `{state,code,pickedFileIds}` for
Drive; the provider comes from the command selector. Google's file picker
returns selected IDs in `picked_file_ids`; clients validate and forward them
as the `pickedFileIds` array.
`accounts check google-gmail|google-calendar|google-drive` verifies the selected
authorized access. Google refresh, token exchange and revoke run on the body;
the console accepts the `clankie://accounts/google/callback` link through a
masked prompt. Gmail requests `gmail.readonly`; Calendar requests
`calendar.calendarlist.readonly` and `calendar.events.readonly`; Drive requests
only `drive.file` through Google's file picker, with no other scope combined.
The body reads files selected in that flow. Google's selected-file permission
also permits editing those files; Clankie's implemented Drive tools only read.
Gmail and Calendar consent also request `openid email` to verify identity.
Drive identity is verified through the Drive API. No mail-send or calendar-write
scope is granted, and the shipped Google tools expose no writes. The
[Google Picker guide](https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker)
describes the selected-file consent flow.

Google grants share an application and account lifecycle. Disconnecting any
Google row disables all three Google connections on this body. If the provider
cannot confirm revocation, local access stays disabled and the catalog reports
pending revocation; retry disconnect or review the grant at Google's management
URL. A connection is never reported as revoked until Google confirms it.
Real Google access requires developer client registration and the owner's
browser consent; fixture checks do not establish a consented production read.

`accounts connect linear` returns the registered app's authorize URL, single-use
state and expiry. The body retains the S256 verifier and exchanges the callback
code. `accounts complete linear --json-stdin` consumes `{state,code}` from stdin;
codes do not belong in argv or logs. The console accepts the Open Clankie
callback link through a masked prompt. The separately configured Mac
`/connect linear` MCP connection remains available.

For worker names and portraits, use a workspace-owned app:
`accounts connect linear-app --client-id ID --secret-stdin`. The secret enters
through stdin and is verified and stored by the service, never returned.
`/connect linear` also offers **Connect a Clankie app**. `accounts list` reports
the verified `actor` and `workspace`. This updates the legacy MCP/app lane;
the registered API connection remains separate and takes precedence when present.
Changing the active app identity requires new worker grants. Setup and scope:
[worker posts](linear-worker-posts.md).

`accounts apps [set|clear] [--github-client-id ID] [--linear-client-id ID]
[--linear-redirect-uri URL] [--google-client-id ID] [--google-redirect-uri URL]`
reads or writes the public OAuth client settings
(`oauthApps` in `settings.json`); they apply without a restart.
`CLANKIE_GITHUB_OAUTH_CLIENT_ID`, `CLANKIE_LINEAR_OAUTH_CLIENT_ID` and
`CLANKIE_LINEAR_OAUTH_REDIRECT_URI` override them, which is how a hosted body
is configured. An owner-run self-hosted body may revoke its own GitHub token
using its own OAuth app's secret as broker entry `github-oauth-app`.
Explicit owner provisioning on that self-hosted body uses
`accounts apps github-secret --client-id ID --secret-stdin`; it stores the secret
only in the broker and returns a closed outcome. It requires operator access
and refuses hosted bodies. Clankie's shared developer secret is never delivered
to customer bodies. Hosted GitHub disconnect removes local access and returns
the GitHub permission-management URL with `revoked: false`. Self-hosted
revocation deletes only the selected token, preserving other body tokens.
Hosted public app
IDs and the exact gateway `/account/connections/callback` arrive through body
bootstrap; developer secrets are excluded. Provider app registration and terms
acceptance remain owner actions.

For a local development Google web OAuth client, set its public client ID and
registered redirect URI through `accounts apps set`. The callback path is
`/account/connections/google/callback`; HTTPS is required except for local
loopback HTTP development. Store the matching developer secret with
`accounts apps google-secret --client-id ID --secret-stdin`. This is a local
operator command, writes broker entry `google-oauth-app` with its client ID,
and refuses hosted bodies and remote transports. The secret never enters argv,
environment variables, settings, output or device responses. Google public
settings also support `CLANKIE_GOOGLE_OAUTH_CLIENT_ID` and
`CLANKIE_GOOGLE_OAUTH_REDIRECT_URI` overrides; neither variable accepts a secret.

<a id="voice-status-voice-model-set-model-id-voice-model-clear"></a>

### `voice [status]` / `voice brain set PROVIDER [MODEL_ID]` / `voice model set MODEL_ID`

The headless launcher inspects voice settings, selects the voice brain, and
changes an already configured ElevenLabs speech model. These commands store
public settings locally; they never make a model call or restart a service.

`voice status` returns `voice` (stored), `effectiveVoice`,
`overriddenByEnvironment` (environment variable names), `settingsFile`, and
`restart`. No credential is returned. `voice model set/clear` changes only the
ElevenLabs model, preserving the voice ID, realtime provider, consent and all
other settings. Select an ElevenLabs voice ID with the console's `/voice` first.

`voice brain set openai|xai|anthropic [MODEL_ID]` selects the conversation brain.
Omitting the model keeps that provider's prior model or its runtime default;
`voice brain model clear` restores the selected brain's runtime default. The
OpenAI and xAI models, voices, and inactive ElevenLabs configuration remain
stored when switching. xAI selects its native speech output; OpenAI keeps the
currently selected speech output. Anthropic selects ElevenLabs and refuses to
save until an ElevenLabs voice ID is configured.

Anthropic's default is `claude-sonnet-5-5`. It receives attributed transcript
text and conversation context; OpenAI transcribes consented audio and
ElevenLabs synthesizes Clankie's chosen words. The active Discord body needs
separate brokered API credentials under `anthropic`, `openai`, and `elevenlabs`.
Use `/voice` or `/auth` to store those keys; environment credentials and Claude
subscription tokens are refused. `/voice status` shows all three key checks.

```bash
clankie voice status
clankie voice brain set anthropic claude-sonnet-5-5
clankie voice model set eleven_v4_turbo
# After reviewing settings and arranging an interruption of active calls/work:
clankie restart clankie
```

`eleven_v4_turbo` selects Text to Dialogue multi-context WebSocket synthesis.
An unset model retains `eleven_flash_v2_5` on the legacy TTS transport. To roll
back an originally unset model, use `clankie voice model clear`, then the same
restart. If a model was explicitly set, restore it with `model set ORIGINAL_ID`.
To return to the prior brain, use `voice brain set ORIGINAL_PROVIDER` with its
retained model. If its speech output was native OpenAI, select that stack again
with `/voice`; returning from Anthropic to OpenAI preserves ElevenLabs output.
Then use the same restart after arranging an interruption of active calls.
Environment overrides still win: check `effectiveVoice` before restarting.
This command is local-only; hosted mode refuses it. See the
[voice operating guide](../apps/discord-bridge/README.md) for verification limits.

### `work sync --json COMMAND`

Reads and writes the built-in tracker sync protocol through the existing
operator dispatch API. Supply a `TrackerSyncCommand`: `bootstrap` (`type:
full|partial`, `projects`, optional `lazy`), `batch` (`projects`, `models`),
`subscribe` (`projects`, `storeId`, `lastSyncId`, optional `waitMs`/`limit`),
or `transaction` (required `idempotencyKey`, `operations` of existing write
tools and arguments, optional `expectedStoreId` from the bootstrap metadata). A
transaction whose `expectedStoreId` no longer names the store is `refused` with
reason `store_replaced`, with no model write; its receipt records the refusal. Output is the typed result; bootstrap contains JSON lines
in `ndjson`, ending with snapshot cursor and model count metadata. Subscribe
waits on committed changes, for at most 20 seconds. A keyed transaction is
atomic across 1–50 operations; receipt lookup uses `work call get_write_receipt`
(or `work owner get_write_receipt` for the owner's own writes), since receipts
belong to the actor that wrote them.
On the operator credential a transaction writes as Clankie for the owner, like
every other `clankie work` tracker verb (see [who a write is from](#who-a-clankie-work-write-is-from)).

Full bootstrap `projects: ["*"]` returns every tracker project UUID, `unprojected`
and `workspace` in metadata `syncGroups`. Every subscription includes `workspace`
for project discovery and project-level metadata. On a new project delta, partially
bootstrap that UUID and add its group, preserving other cached groups. Group
selection uses tracker UUIDs only, never project names or polling.

Devices use op `tracker_sync` on `POST /operator/v1/dispatch`. The relay emits
bootstrap directly as NDJSON; `POST /operator/v1/tail` with a subscribe command
streams `kind:tracker_sync` pages. Chat grants authorize reads; terminalControl
authorizes writes as the authenticated app actor. A `rebootstrap` result means
replace the named groups with a partial bootstrap before resuming. Apply whole
commits before saving `lastSyncId`, and never let lazy hydration overwrite a
newer delta. See the [sync contract](adr/0226-one-tracker-tool-surface.md#amendment-built-in-tracker-sync-journal-2026-10-09-vuh-1962).

### `work [status]` / `work init` / `work list|show|create|update|close|attach|write|receipt`

Tracks work where the repo already does ([ADR 0191](adr/0191-work-is-tracked-where-the-repo-tracks-it.md)):
its Linear team (through the Linear account connected to Clankie), its GitHub
issues (through the owner's `gh` login), its own one-file-per-item Markdown
directory, or `.clankie/work/` when it has none. Every command runs against the
git repo containing the current directory, or `--repo PATH`, and prints JSON.
It is a compatibility CLI over the same Linear-shaped tracker tools Clankie and
workers discover as `linear_*` ([ADR 0226](adr/0226-one-tracker-tool-surface.md)).
Issue reads and searches, patch edits, labels, relations, comments and replies,
projects and project status updates use the same input shapes with connected
Linear or durable local storage. `clankie doctor` reports the active backend and
selection reason. An explicit `repo` tool argument selects the repo's recorded
GitHub or Markdown adapter.

#### Items of a cut-over project

A project cut over to the built-in tracker keeps only a frozen copy in Linear.
A call that names one of its items goes to the built-in tracker, from any repo
and any caller ([VUH-2829](adr/0226-one-tracker-tool-surface.md#proposed-amendment-cutover-and-switch-back-2026-10-09-vuh-1987)).
An item is named by its imported `VUH-n`, its `LOCAL-VUH-n`, its UUID, or the
project's UUID or name. Evidence bundle and run IDs also identify their owning
issue's project (`bundleId`, `runId`, run update `id`, and `parentRunId`). Saved
view, guided-review and cycle IDs are indexed too; views still require exact
`project`/`storeId`, and guided reviews still require `issueId`. Routing does
not change role permissions or request budgets. An unknown ID cannot select a
project. A built-in-only call without a usable reference uses the hire's project
or explicit `repo`; with a Linear destination it refuses before provider dispatch.
Receipt keys, cursors and store IDs do not select projects. Examples:

- `clankie work show|activity|update|close|attach ID` behaves as if
  `--project` named the item's project, even with `--repo` on a Linear repo,
  and `clankie work write ID` writes it there, with its receipt bound to that
  project's repo;
- a `linear_*` tracker tool call without `repo` goes to that project's repo;
- a `linear_graphql` mutation, or another Linear-only write, that names the
  item is refused with a pointer to the built-in tracker.

To read the Linear copy for history, add `"linearHistory": true` to a read
tool's arguments. The call reaches connected Linear without routing and returns
`{ "linearHistory": "Linear history: …", "result": … }`. A write or a `repo`
call with `linearHistory` is refused, and so is a history read while Linear is
not connected. Linear reads that cannot be routed, such as `linear_graphql`
queries naming the item, come back in the same envelope.

#### Built-in item identifiers after cutover

The built-in tracker deliberately keeps its own namespace. A default new store
uses `LOCAL-n`; after cutover of an imported `VUH` team, new items use
`LOCAL-VUH-n`, starting
at `LOCAL-VUH-1`. Imported items retain their exact `VUH-n` identifiers and UUIDs.
The native sequence is independent of Linear's sequence: `LOCAL-VUH-2` and
`VUH-2` are different items, even when their numeric suffixes match.

Keep the entire identifier in lookups, links, evidence keys and commit messages.
Never shorten `LOCAL-VUH-2` to `VUH-2`. Native identifiers remain stable across
restarts; the persisted store counter advances when a new item commits, and a
keyed retry returns the original item without allocating another number.
Cutover preserves imported identifiers and the native counter; it does not
renumber or migrate either namespace. See the
[identifier decision](adr/0226-one-tracker-tool-surface.md#amendment-evidence-keys-are-the-trackers-own-identifiers-2026-10-09-vuh-1991-vuh-1997).

#### Who a `clankie work` write is from

The operator credential proves a caller on this machine, not the person at the
keyboard: the lead seat, a hired worker's shell and the owner's own terminal all
hold it. So on the built-in tracker every `clankie work` write (create, update,
close, write, bundles, asks, cycles, leases, run controls and `work sync`) is
recorded as Clankie, the `agent-worker` `clankie`, on behalf of the owner. It is
self-echo: it never wakes Clankie as owner activity, and it cannot verify,
reopen or self-check work Clankie did. The ordinary CLI also lacks the private
lead conversation authority required to close built-in work under `closure: lead`.
Two surfaces speak as the owner:
the app on an enrolled device, and `clankie work owner TOOL`, the owner's
explicit own call. Agents never use `work owner`. The owner's "It works" answer
to a verify ask counts as the bundle check and verifies the item (LOCAL-VUH-1).

These actor assignments do not isolate the owner's terminal from agent shells.
The explicit `work owner` route and owner ask answers still accept the shared
operator bearer (LOCAL-VUH-4). A same-user unrestricted shell can also reach
device signing material and mutable service/state. Worker markers, a separate
bearer stored under the same user, and file mode 0600 do not establish human
authority. [ADR 0253](adr/0253-owner-confirmation-needs-an-isolated-authority.md)
describes the proposed protected authority; it has not shipped. Agents must
leave owner verification and owner ask answers to the owner.

Built-in Done and owner verification are separate under the owner's effective
lead-closure policy. The current host-authorized lead may close an item after
it has landed and its acceptance evidence bundle has an independent check.
The item retains its `landed` or `delivered` stage and records `leadCompletion`
with the lead actor, time and checked bundle ID; it does not claim the owner checked
it. The current lead is the chat the owner bound to the project while that chat
exists; otherwise, for an Auto project, the chat Auto routing currently assigns
its round, rechecked at write time; otherwise, for an unbound project, the
default chat. Missing, revoked or ambiguous lead scope refuses closure. The owner alone
may verify or reopen it. Lead closure suppresses new automatic verification asks;
existing asks and explicit decision, money, account and other owner gates remain.
Under owner closure, work stays In Review for the owner's ordinary verification.

- `clankie work` (or `work status`, `work discover`) reports the repo's signals,
  its recorded convention if any, and a `question` when discovery found more
  than one tracker or only a single `TODO.md`. Answer it once with `work init`.
  Its `trackerRequestBudget` is `GET /v1/tracker/request-budget`. For each hired
  seat that called a tracker tool in the last hour, it lists the role, the
  interactive and background requests (600 an hour) and writes (60 a minute)
  used, any `retryAt`, and the `role_not_allowed` and `tracker_request_budget`
  refusals. The owner and Clankie are never limited. `doctor --json` includes the
  same report as `trackerRequestBudget`.
- `clankie work init` records what discovery found; `work init --backend
default|markdown|github|linear [--directory D] [--github-repo OWNER/NAME]
[--linear-team KEY] [--linear-project NAME] [--linear-label LABEL]
[--release-source tags|milestones|both] [--release-lane NAME] [--note TEXT]` records the owner's
  choice. The answer is written to `.clankie/tracking.json` in the repo; nothing
  else is added to a repo that tracks work elsewhere.
  `--linear-label` saves an existing Linear label as `linear.label`, scoping
  this repo's board within its team/project and adding the label to new items.
  It requires a Linear convention with a team; blank, multiline or over-64-character
  labels are refused. Omit it to keep the team/project-wide board. The HTTP init
  parameter and the device write's init parameter are `linearLabel`.
- `clankie work project` (also `/work project` in the TUI) returns planned
  milestones, shipped `v*` versions and Linear initiative goals for the saved
  tracker. `work init --release-source tags|milestones|both --release-lane NAME`
  changes the release selection without changing an existing tracker. Source
  defaults to `both`; lane defaults to `repository` until explicitly named.
  Separate mobile/macOS repos can name their own lanes. Dates say whether they
  came from a publication, annotated tag or lightweight tag's commit. Missing
  store builds and release membership are not inferred. Markdown has no planned
  milestone collection; GitHub and Markdown return no initiative goals.
  Failed/unsupported sections carry explicit `unavailable` entries.
- `clankie work releases sync [--repo PATH]` records the repo's shipped `v*`
  versions as releases in the built-in tracker
  ([ADR 0226 amendment, VUH-1930](adr/0226-one-tracker-tool-surface.md#amendment-releases-2026-10-09-vuh-1930)).
  It uses the same tag source as `work project`. Each release's items are the
  keys named by commits since the previous version, in version order:
  `LOCAL-…` plus the convention's Linear team. Built-in items move to
  `delivered` on the first release that ships them, provided their evidence bundle
  has an independent check. Imported items with no recorded delivery stage retain
  release membership without a stage move. Missing proof or another item refusal
  does not abort the sync: `skipped` names each unchanged built-in item, its version,
  reason and detail. Syncing again is a no-op
  for items that are already delivered. `clankie work releases [--lane L]
[--item KEY] [--limit N]` lists releases newest first. `clankie work release
ID|VERSION` shows one release, with each item's commits and, for built-in
  items, their stage. These run as Clankie for the owner through
  `POST /v1/tracker/releases/sync` and `POST /v1/tracker/call`.
- `clankie work cycle [--project P] [--type current|previous|next|all]` reads
  built-in tracker cycles with their event-stream summary: planned, added,
  rolled in, removed, finished, rolled over, in flight. `work cycle show ID
[--project P]` reads one cycle. `work cycle add ITEM [--to current|next|N]`
  and `work cycle remove ITEM` set membership as Clankie for the owner. `work cycle length
PROJECT DAYS` sets the project's cycle length (default 7), starting with its
  next cycle. Unfinished items roll into the next cycle on the first access after
  one ends
  ([ADR 0226 amendment, VUH-1931](adr/0226-one-tracker-tool-surface.md#amendment-cycles-2026-10-09-vuh-1931)).
- `clankie work ready [--project P] [--limit N]` lists the ready queue. These are
  open, unblocked, unleased items with no active run, current cycle first, then
  priority, then oldest. `work lease ITEM [--minutes N] [--release]` takes,
  renews or releases an item's lease (30 minutes by default; it expires on its
  own). `work runs [ITEM] [--status S]` lists runs with their attempt, parent,
  worktree, cost and live seat/hire link. `work drift [--project P]
[--idle-days N]` lists stale leases, runs still active on closed items, and
  items idle for N days
  ([ADR 0226 amendment, VUH-1918](adr/0226-one-tracker-tool-surface.md#amendment-runs-leases-the-ready-queue-and-drift-2026-10-09-vuh-1918)).
- `clankie work changes [--project P] [--since N --store-id ID] [--wait SECONDS]
[--limit N]` reads `list_changes`: one project's commits after syncId N,
  oldest first, as changed fields and ids with comment, event and run bodies
  omitted. Pass back the returned `syncId` and `storeId`; follow while `hasMore`.
  `--wait` (up to 20 seconds) holds the call until a change arrives.
  `outcome: "rebootstrap"` means the store was replaced or the cursor is ahead of
  it. Without `--since` it starts from now; without `--project` the repo's own
  built-in binding decides. `linear_list_issues` and `linear_list_ready_issues`
  take `snapshot: true` to page one moment and return the `syncId` to follow
  from ([ADR 0226 amendment, LOCAL-VUH-43](adr/0226-one-tracker-tool-surface.md#amendment-agents-follow-changes-by-cursor-2026-10-27-local-vuh-43)).
- `clankie work bundle set ITEM --json '{"references":[{"recordId":"UUID",
"sha256":"HASH","url":"clankie://evidence/sha256/HASH","type":"log"}],"gaps":[]}'`
  publishes the current built-in item bundle. Add `runId` to the JSON to attach
  it to a run instead. References name real evidence-store records with matching
  lowercase 64-character hashes and links; supported types are `log`,
  `screenshot`, `video`, `diff`, `eval`, `other`. No bytes go into the tracker.
  `work bundle show ITEM [--run ID]` reads it; `work bundle check BUNDLE_ID
[--body TEXT]` checks it as Clankie for the owner, so it is refused when
  Clankie published the bundle or did the work; a worker cannot self-check either. Replacement
  bundles need a fresh check; the owner must reopen an item past landed before
  replacing its completion bundle. Completion past landed needs the item's bundle
  and a check; the owner's existing "It works" answer counts as a check.
  The owner's paired app can also give a verdict with `post_owner_verdict`
  ([ADR 0299](adr/0299-the-owners-app-gives-the-verdict-on-finished-work.md)). It has no
  CLI form, because the operator credential is refused on purpose.
  For native-first work, an already-hired genuinely independent peer in the same
  project inspects the current ISSUE bundle and uses `linear_post_bundle_check`
  through its own authenticated `clankie_call`. Read back the same current bundle's
  checked actor/event ID and matching `bundle_checked` issue event. A run-bundle
  check does not replace the ISSUE check. Native children sharing the implementer's
  bridge retain the parent's tracker identity; the CLI writes as Clankie, not as
  the peer. Preserve the producer, deliverable and holds. An unavailable checker
  remains a gap; changing an actor, grant or deliverable cannot supply independence.
- `clankie work ask ITEM --body TEXT` raises an ADR 0245 owner decision ask,
  linked from the item. `work gate ask ITEM --run ID --kind
plan|spend|destructive_action|merge|external_write --body TEXT` blocks that run
  immediately and raises an ADR 0245 ask with purpose `gate`. The linked
  `requestId` appears after the host publishes it. Use the existing `clankie conversations questions|answer` commands to choose Approve. Decline, free text and
  cancellation do not unblock the gate; every pending gate needs approval.
- `clankie work run steer|pause|resume|stop ID [--body TEXT]` records a lead
  control event, never an owner approval. The additive `linear_post_run_control` tool also permits the
  lead; workers are refused. Paused or gated runs refuse updates except
  cancellation. Resume clears only the pause; stop cancels the attempt. These
  commands change tracked run state and do not deliver native terminal input
  or kill a process. The tool/API contract is the
  [VUH-1919 amendment](adr/0226-one-tracker-tool-surface.md#amendment-evidence-bundles-owner-asks-and-run-gates-2026-10-09-vuh-1919).
- `clankie work call TOOL [--json ARGS]` makes Clankie's call to the built-in
  tracker for the owner (`POST /v1/tracker/call`) with a `linear_*` tool name
  (prefix optional), recorded like every other `clankie work` write.
- `clankie work owner TOOL [--json ARGS]` makes the owner's own call to the
  built-in tracker (`POST /v1/tracker/owner/call`) with a `linear_*` tool name
  (prefix optional), for example `work owner get_issue --json
'{"id":"LOCAL-1","includeReleases":true}'`. Owner writes there are owner
  activity: they can verify, reopen and wake the routed chat. The owner is never
  refused a bundle check, even on work he did himself.
- Work statuses are `backlog`, `todo`, `in_progress`, `in_review`, `done`, and
  `canceled`. Linear backlog/triage, GitHub `status: backlog`, and Markdown
  `status: backlog` stay distinct from todo. Items may carry a native milestone
  id/name; Markdown uses both `milestone_id` and `milestone_name` front matter.
  Device `work_items` requests opt into these facts with `statusVersion: 2`;
  older requests receive backlog as todo and omit the new milestone field.
  A device `work_items` request with `itemId` reads that one item directly, as
  `work show` does, so the app can open an issue its repo's 250-item list does
  not reach; it returns that item, or none when the tracker has no such item.
  `work_project` uses the same registered repo ids and device authority as
  `work_items`. Metadata reads share connected-account snapshots and pagination,
  preserving the poller's provider budget.
- `clankie work repos` lists registered repositories, saved project trackers and
  projects in Clankie's connected Linear account. Linear projects have read-only
  `linear-<UUID>` references usable with `work list`, `show`, `activity`,
  `project` and `project-details`, including when their checkout is remote or
  absent. These reads register no repository and change no settings. A saved
  exact Linear UUID associates a World project; names do not. Projects cut over
  to the built-in tracker are listed through that tracker. A local command that
  names a repository path still registers it; paired devices name returned IDs.
  A linked Git worktree (a hire's, or Claude Code's `.claude/worktrees/agent-…`)
  registers under its own path, so file-backed work stays where its agent
  commits, and is named after its main checkout, never its folder. When that
  checkout is registered and both read the same Linear or GitHub tracker, the
  list offers the checkout alone; otherwise the worktree stays listed as
  "<checkout> (worktree)" so its own items remain discoverable.
- `clankie work list [--status todo,in_progress] [--owner NAME] [--label L]`,
  `work show ID`. `--label` keeps items carrying that label, matched
  case-insensitively; it is how a role station reads its backlog
  ([ADR 0208](adr/0208-agents-carry-a-role-the-world-reads-it.md)). Items carry
  `labels` from the backend: Linear labels, GitHub labels (without the
  `status: …` labels this backend writes), or a Markdown item's `labels:` front
  matter (`[a, b]`, `a, b`, or a YAML block list).
  On a scoped Linear board, `--label` intersects the saved repo label along
  with status/owner filters; it does not replace the scope. `show ID` remains
  a direct known-item read. Board scope does not grant or restrict tool authority.
- `clankie work activity ID` reads an item's comments and state changes, oldest
  first: each names its actor as the tracker records it (Linear's state history
  names none), with body, attachments and reply target. Linear and the local
  tracker keep activity; Markdown and GitHub repos answer unavailable. Devices
  read the same through `work_item_activity`.
  Paired devices also read an issue's evidence store records through
  `evidence_records` (by issue key) and a small look at one blob through
  `evidence_preview`: an image up to 64 KiB as base64 or UTF-8 text, never a
  signed link to the service. A larger recorded PNG (up to 16 MiB and 16.7M
  pixels, not interlaced) gets a complete host-side thumbnail under the same
  64 KiB cap: JPEG with a 768-pixel long edge, stepping down to 256 until it
  fits. An image with transparency stays PNG when one fits with at least a
  512-pixel long edge; otherwise it is flattened onto white as JPEG. The
  record authorizes the request and gives the size before any cached rendition
  is used or the blob is read; a large blob is opened only inside a render,
  which passes its deadline to the storage read so a store that honours it
  (S3) stops when it passes. Renditions are cached in memory by sha256. Two
  renders run at a time with up to 32 waiting at most 15 seconds. Each render
  has five seconds, enforced by a timer during reads and by elapsed-time
  checks between codec steps, so a rendition that finishes late is discarded
  (a refusal that depends only on the bytes is still kept). A busy or
  timed-out render answers `unavailable` without a cached rendition, and a
  timed-out sha256 is not rendered again for a minute. Other large files still
  answer `too_large`; a malformed or interlaced PNG answers `not_previewable`.
  The original stays unchanged. The bearer `/v1/evidence/*` routes stay
  operator-only, and their `preview` route is unchanged.
  Media embedded in work (VUH-2666) resolves through `work_media`: a device
  sends up to 32 links it found in items, project updates or comments, and each
  answers `ready` with the evidence blob's sha256, content type, kind
  (`image`, `video` or `file`) and size, `pending` while the service downloads
  it (ask again shortly), or `failed` with a reason. A
  `clankie://evidence/sha256/…` link resolves only to a recorded blob. A Linear
  upload (`uploads.linear.app` or `public.linear.app`) is fetched only when a
  `work_items`, `work_project_details` or `work_item_activity` read returned it
  within the last six hours; anything else answers `not_returned` and is never
  fetched, so this is not a proxy for arbitrary URLs. The service downloads the
  upload once with the connected Linear app (no redirects, 128 MiB and 30
  seconds at most, two at a time), records it as evidence and caches it by the
  link without its signature; a failed download is retried after five minutes.
  Only raster images, video and PDF keep their type. HTML, SVG and anything
  else are recorded as `application/octet-stream` (kind `file`), so an upload
  can never become inline-renderable evidence.
  The device then reads the bytes through `evidence_preview` and
  `evidence_fetch` and never holds a Linear credential.
- `clankie work create TITLE [--summary S] [--owner NAME] [--criterion C]...
[--status S] [--priority 0..4]`.
  Summary prose has no separate 20,000-character cap, matching canonical
  `save_issue` descriptions. `work show` and API item reads return it in full;
  provider and transport request limits still apply.
- `clankie work update ID [--status S] [--owner NAME | --no-owner] [--title T]
[--priority 0..4] [--check N]... [--uncheck N]... [--add-criterion C]...`; criterion numbers are
  1-based and may be comma-separated.
- `clankie work close ID [--canceled]` sets `done` (or `canceled`).
- `clankie work attach ID --url URL --caption TEXT [--kind image|video|log|link]`
  appends evidence; the kind is inferred from the URL when omitted.
- `show`, `activity`, `update`, `close` and `attach` take `--project P` for an
  item in the built-in tracker, with the project UUID or name that
  `work ready --project` takes. The item resolves by its `LOCAL-…` identifier or
  UUID in that project, whatever repo the command runs from; an item outside it
  answers `not_found`. The selector wins over `--repo`, including `linear-…` and
  `project-…` references. Only this machine's CLI and agents use it; devices
  read through their repo IDs. Done still follows the built-in tracker's
  lead-closure policy (landed, checked evidence bundle, lead authority), which
  `work close` does not carry; it answers `owner_verification_required`.

`clankie work write ID --owner NAME|--no-owner|--add-label ROLE|--remove-label
ROLE|--add-blocker ID [--request-id UUID]` performs exactly one owner-authorized
change to an existing item. `--owner` sets its work metadata, not a provider user
assignee. The CLI allocates an ID before dispatch when omitted; retain that ID
from the JSON result. `clankie work receipt ID --request-id UUID` reads the
original result. Both accept a registered or project repository ID in `--repo`;
a local path resolves to an already registered repository. Use `work status`
to register it before writing. Project references require their local saved
tracker workspace. GitHub writes require its connected account.

The JSON result includes `requestId`, `outcome` (`applied`, `refused`,
`uncertain`), a plain `message`, and optionally the refreshed `item`. Repeating
an ID reads its receipt after checking the original owner, item, binding and
command; it never writes again. If the response is lost, inspect the receipt
and tracker rather than sending the same change with a new ID. Labels and
blockers merge into freshly read state, preserving unrelated labels and
prerequisites. GitHub status labels are reserved. `parent` is optional read
metadata, separate from blockers.

Paired devices with `terminalControl` use the owner-preserving operator ops
`work_item_write` (`request: {repoId, itemId, requestId, command}`) and
`work_item_write_receipt` (`repoId`, `itemId`, `requestId`). Commands are
`{action:"assign", owner:NAME|null}`, `{action:"add_label", label:ROLE}`,
`{action:"remove_label", label:ROLE}`, or `{action:"add_dependency", id:ID}`.
The host checks owner authority again at publication and audits each write;
chat and execution credentials cannot authorize it. Local HTTP uses
`POST /v1/work` with `{action:"write", request:...}` or
`{action:"write_receipt", request:...}` and the operator bearer.

Statuses are `todo`, `in_progress`, `in_review`, `done` and `canceled`,
projected onto each backend's own states. Priority is `0` (none), `1` (Urgent),
`2` (High), `3` (Medium), `4` (Low); open work sorts Urgent through Low, with
unprioritized work last, before limits. When Linear is disconnected the common
surface uses local storage; a connected failure never replays a write locally.
Connected Linear issue lists share a sorted snapshot for up to 60 seconds,
including their cursor pages and concurrent readers. Writes and verified
webhooks invalidate it; an expired or invalidated cursor requires restarting the
listing. Failed list reads wait at least 30 seconds before another provider scan.
Direct issue reads remain fresh for read-before-write checks. The service's
`mcp.host.call` log includes `trackerRead.providerPages`, so a cache hit records
zero provider requests rather than looking like another Linear scan.
Local records persist across restart and do not automatically migrate on
connection. Other unavailable repo providers answer `backend_unavailable`. The HTTP
form is `POST /v1/work` with the operator bearer and `{ "action": ... }`.

### `work review-diff BASE HEAD [--repo PATH]`

Reads the change between two commits of a local Git repository for a guided
review, as JSON: the resolved full commit IDs, then each file's change kind,
paths, modes, blob IDs and hunks with old/new line anchors. It reads Git objects
only, never the checkout, index or a remote, runs no configured diff, textconv,
pager, fsmonitor or hook command, and needs no service or credential. Option-like,
unknown or ambiguous refs answer `{ "outcome": "refused", "code" }`. Changes over
200 files or 1 MiB of patch, or a binary verdict under the repository's own
`info/attributes`, answer `complete: false` with the reason; exit 0 means a
complete result. Contract and limits: [guided reviews](guided-reviews.md).

### `work review-patch FILE`

Reads one local Git patch file (`git diff` output) for a guided review, as JSON:
`source: "patch"`, the file's `sha256` and size, then each file's change kind,
paths, stated modes, unverified `index` IDs (`claimedObjects`) and hunks with
old/new line anchors. It opens only that regular file, runs no Git or other
process, opens no path the patch names, applies nothing and needs no service or
credential; `--repo` is refused. Empty, oversized (over 1 MiB, 200 files or 2000
hunks), non-UTF-8, truncated, contradictory or unsupported patches answer
`{ "outcome": "refused", "code" }` and exit 1. Contract: [guided
reviews](guided-reviews.md#reading-a-supplied-patch).

### `work review save|show|list|edit|retire` (built-in tracker)

Persist an inspected local Git change or supplied patch with an ordered
walkthrough, anchored severity findings, replies and resolution history:

```bash
clankie work review save --json "$(cat review.json)"
clankie work review show REVIEW_ID --issue ITEM
clankie work review list --issue ITEM --limit 20 [--cursor CURSOR]
clankie work review edit REVIEW_ID --issue ITEM --json "$(cat edit.json)"
clankie work owner post_retire_guided_review --repo /repo --json "$(cat retire.json)"
```

Save JSON requires `issueId`, `source`, `expectedSource`, `walkthrough`,
`findings` and `idempotencyKey`; `runId` is optional. Git source is
`{kind:"git",repository,base,head}` with expected identity
`{kind:"git",gitDirectory,baseCommit,headCommit}` copied from `review-diff`.
Patch source is `{kind:"patch",path}` with
`{kind:"patch",sha256}` copied from `review-patch`. Save re-inspects locally
and refuses incomplete or changed sources. The host defaults to denying source
reads: canonical local project workspace repositories and existing approved
genuine linked worktrees are eligible; arbitrary, symlink-aliased or remote-machine
host paths are not. Worker tool/project ceilings still apply. Missing source
authority returns `source_authority_required`, disallowed sources return
`guided_review_source_refused`, and changed issue bindings return
`source_authority_changed`. Capture runs outside the store lock; identity/binding
checks under the lock and a publication fence guard the write. Saved snapshots
remain readable after source removal.

Edit JSON requires `findingId`, saved `identity` as `expectedSource`, current
review `updatedAt` as `ifUpdatedAt`, a fresh `idempotencyKey`, and
`edit: {action:"reply",body}` or `edit: {action:"resolve",resolved:true}`.
Set `resolved:false` to reopen. Sources and anchors cannot be edited.

At most three active reviews are retained per issue. Active immutable snapshots
share an 8 MiB store budget; discussion and mutation receipts are excluded.
Each review independently allows 256 KiB of serialized discussion.
`guided_review_discussion_budget` affects only that review; other reviews remain
editable even when snapshot capacity is full.
Replies and resolve/reopen events share that budget. After saturation,
resolution and reopening can also refuse; the last accepted state is preserved.
All three capacity refusals direct an authenticated owner to retire an eligible
review with `clankie work owner post_retire_guided_review`, then save a new
revision on the same issue using fresh keys. Retire the saturated review to
recover discussion; ordinary workers and unproven native leads cannot reclaim.

This unlanded contract returns compact save/edit/retire results:
`{schemaVersion:1,reviewId,storeId,issueId,projectId,identity,snapshotSha256,operation,eventId,updatedAt,actor}`.
`operation` is `save`, `reply`, `resolve` or `retire`; `eventId` is a string or
null. Retries and `get_write_receipt` replay that exact compact result, even
after retirement. Full historical payload replay is no longer promised for new
writes. `show` reads the current full active review; `list` returns summaries.
Retired get/list results are identity tombstones with `retiredAt`/`retiredBy`
and no payload. Legacy full-result/pointer receipts keep their original replay
semantics and block retirement with `guided_review_legacy_receipts`.

Owner-call retire JSON requires `issueId`, `id`, saved identity as
`expectedSource`, current `updatedAt` as `ifUpdatedAt`, and a fresh
`idempotencyKey`. The existing `work owner` command uses authenticated
`/v1/tracker/owner/call`. Only a proven owner principal may retire under normal
issue/project scope. The generic `review retire ID --issue ITEM --json JSON`
route refuses `guided_review_retire_authority` without that principal; its normal
Clankie-for-owner actor stamp does not prove owner authority. Current routes fail
closed to owner-only retirement. Native lead support needs a proven host
capability and is not implemented here; client actor labels, role claims and
`--actor` do not grant authority. Owner activity does not verify acceptance. Retirement checks revision and source
identity without host source reads. It irreversibly releases active review and
byte capacity in the same issue/store, preserving identity, compact receipts and
audit. Retired edits refuse `guided_review_retired`; replay never restores a
payload. At `guided_review_limit` or `guided_review_budget`, choose an eligible
review to retire explicitly. There is no automatic eviction, successor issue
workaround, parallel store or source rebinding.

These service calls require explicit authenticated actors and an existing
built-in issue. They use tracker receipts/audit, never verify acceptance or
write an upstream verdict. They provide no UI/device sync projection.
Full payload examples and limits: [guided reviews](guided-reviews.md#saving-a-local-guided-review).

### `work inbox list|get|snooze|unsnooze` (built-in tracker)

Defer attention on a current tracker-linked pending decision, gate or verification
question. This never answers, approves, cancels, verifies or controls the work.
Use the exact bound tracker project UUID and current `storeId` from Work sync
bootstrap, and the `target` and revisions returned by the inbox read.

```bash
clankie work inbox list --repo /absolute/repo --project UUID --store-id STORE
clankie work inbox list --repo /absolute/repo --project UUID --store-id STORE --attention all
clankie work inbox get --repo /absolute/repo --project UUID --store-id STORE --target 'TARGET_JSON'
clankie work inbox snooze --repo /absolute/repo --project UUID --store-id STORE \
  --target 'TARGET_JSON' --revision 12 --if-updated-at null \
  --until 2026-10-21T09:00:00-05:00 --idempotency-key my-snooze-001
clankie work inbox unsnooze --repo /absolute/repo --project UUID --store-id STORE \
  --target 'TARGET_JSON' --revision 12 --if-updated-at ATTENTION_UPDATED_AT \
  --idempotency-key my-unsnooze-001
```

`TARGET_JSON` is the full returned target object, never a latest-pending selector.
`--until` must be explicit RFC3339, future and within 30 days. Use the returned
`updatedAt`, or literal `null` when no record exists. Normal reads omit active
snoozes; `--attention snoozed|all` inspects them. Expiry and unsnooze re-read current
pending work. List supports `--limit 1..250` and `--cursor`; continue while
`hasNextPage`. A changed query/data/expiry can invalidate its cursor.

Attention is private to the authenticated actor and exact current project/store;
other devices do not share it through names or on-behalf-of chains. Unsupported
backends and native tools without owner mailbox authority refuse. A
`tracker_uncertain` reply can follow a committed rename: inspect the original
actor/key's write receipt and current attention without sending a new key.
See [Work inbox attention](work-inbox.md) for the minimal contract, limits,
authority and file map. Visual Work discovery remains a subsequent slice.

### `work view save|get|list|apply|delete` (built-in tracker)

Saved views persist named issue filters, never issue snapshots or access rights.
Every operation names the exact tracker `storeId` and project UUID. Obtain the
store ID from the metadata line of `work sync --json
'{"action":"bootstrap","type":"full","projects":["*"],"lazy":true}'` and the project
UUID from `work call list_projects`. Names are not project identifiers here.

```bash
clankie work view save --project PROJECT_UUID --store-id STORE_ID \
  --json '{"name":"Urgent open","filter":{"priority":1,"state":"open"}}' \
  --idempotency-key saved-view-create-001
clankie work view list --project PROJECT_UUID --store-id STORE_ID --limit 50
clankie work view get VIEW_UUID --project PROJECT_UUID --store-id STORE_ID
clankie work view apply VIEW_UUID --project PROJECT_UUID --store-id STORE_ID --limit 50
clankie work view save VIEW_UUID --project PROJECT_UUID --store-id STORE_ID \
  --json '{"name":"Urgent"}' --if-updated-at LAST_READ_UPDATED_AT
clankie work view delete VIEW_UUID --project PROJECT_UUID --store-id STORE_ID \
  --if-updated-at LAST_READ_UPDATED_AT --idempotency-key saved-view-delete-001
```

`save` creates without an ID and updates with an ID; omitted update fields stay
unchanged. Read first and pass `--if-updated-at` for concurrent update protection.
A name is nonblank, at most 120 characters and unique within its project. The
version-1 `filter` accepts the normal `list_issues` fields except `project`,
`limit` and `cursor`; the project is fixed and paging is chosen when applying.
Filter text is bounded to 8192 characters, individual string fields to 2048
characters and field arrays to 32 entries. A store holds at most 1000 views.
`--limit` and `--cursor` reuse normal pagination; changed filters invalidate an
old cursor. Newly matching issues appear and issues that stop matching disappear.
The saved record includes `schemaVersion:1`, store/project IDs, timestamps and
host-attributed actors. It stores no credentials, query code or authorization.

The view CLI selects the saved backend of `--repo PATH_OR_REGISTERED_ID` (default:
current git repository). It requires a current host project binding to that exact
built-in tracker project. An unknown repo or unsupported backend refuses; it never
replays the call against the global tracker. In the HTTP body, optional `repo`
selects that same existing registered resolution and its current fences. Omitting
`repo` preserves the existing direct built-in API behavior. Scope remains explicit
in `arguments.project` and `arguments.storeId` in either case.

The public tools are `save_issue_view`, `get_issue_view`, `list_issue_views`,
`list_issue_view_issues` (apply) and `post_delete_issue_view`. HTTP uses the
existing authenticated `POST /v1/tracker/call` with `{name,arguments}`; write tools
support `idempotencyKey` and `ifUpdatedAt`. The `linear_` tool prefix is only the
existing transport vocabulary. Connected Linear, disconnected Linear, GitHub
and file trackers refuse saved views rather than falling back to a local store.
A view from another project or replaced tracker store is refused, including on
read, apply, update and delete. Saving a filter grants no future access.

Enrolled devices use the existing `tracker_sync` operation on
`POST /operator/v1/dispatch` with read-only commands
`{action:"list_issue_views",project:PROJECT_UUID,storeId:STORE_ID}` and
`{action:"list_issue_view_issues",project:PROJECT_UUID,storeId:STORE_ID,id:VIEW_UUID}`.
Both accept `limit` (1–250, default 50), `cursor` and `orderBy` (`createdAt` or
`updatedAt`). Current chat authority is required before dispatch and return.
The outcomes are `issue_views` with `views`, or `issue_view_issues` with current
canonical `issues`; both include `storeId`, `projectId`, `hasNextPage` and optional
`cursor`, and apply includes `viewId`. Follow the returned cursor for that same
read. Changed filters invalidate it. Existing tracker commits drive refresh,
including definition writes whose sync deltas are empty; no new poller is needed.

This API/CLI contract does not establish native iPhone, iPad or Mac presentation
or the owner's visual acceptance. Those remain separate Work UI checks.

### `evidence push|fetch` / `evidence list|receipt`

Phase A preserves the private destination captured at upload CLAIM, including a
pending PUT retried after configuration changes or a reopen. Fetch and device
ranges resolve recorded destinations; same-SHA reads select the earliest
`(createdAt,id)` record while retaining every association. Unknown legacy locations
are never filled from current settings. S3 startup refuses them until an explicit
internal preparation verifies SHA and size; the helper caps a batch at 100 named
identifiers, 256 MiB and a 30-second association-progress deadline, preserves originals and retains partial
progress. Verified unchanged-local reads remain available without tagging. This
helper has no API/CLI switch or migration control. Both preview implementations
still read the active backend pending a separately cleared follow-up. Authorized
S3 fetch retains the existing short-lived presigned URL contract; private storage
metadata never appears in receipts, record details or device responses.

Unknown pending uploads may receive an explicit private local-only continuation
admission for the exact actor key, receipt ID and full immutable request. It
permits newly supplied bytes rather than claiming a historical destination.
Complete incoming SHA/size verification precedes a pending/NULL transactional
metadata settlement; existing originals are never overwritten, and wrong,
short, cancelled or conflicting inputs remain unresolved. Admissions bound 100
identities/256 MiB declared bytes for 15 minutes, with private guards retained
through every refreshed signed PUT's lifetime. This has no public API/CLI control
or S3 continuation. A genuine post-install database failure may preserve verified
unrecorded bytes plus pending/NULL metadata for explicit retry; filesystem and
SQLite are not one atomic commit.

The manual `apps/clankie/test/evidence-storage.integration.test.ts` check exercises
real SQLite/files, production credential-backed authentication against a real
disposable file broker, production SDK/owned loopback MinIO and actual HTTP. It is
fixture destination proof, not owner activation, full service startup, tenant
credential delivery or real-hosted acceptance.

Moves raw evidence out of git into Clankie's evidence store
([ADR 0258](adr/0258-evidence-lives-in-the-evidence-store.md)). Git keeps each
folder's `README.md` and an `evidence.json` manifest; the store keeps the bytes
and the records that describe them. Paths resolve from the current directory
inside any git repository, with no per-repository configuration. Each command
prints one JSON document; push and fetch also print a plain summary on stderr.

The service defaults to local disk blobs and SQLite records. Supported owner
configuration uses the same authenticated HTTP path as other settings:

```sh
clankie evidence storage status
clankie evidence storage s3 --bucket example-evidence-bucket --region us-east-1 --prefix tenant-evidence
clankie evidence storage local
```

`--expected-revision REVISION` supplies an explicit reviewed revision for a write.
Otherwise the command reads the snapshot before saving; conflict is refused
without retry or settings-file fallback. GET/POST `/v1/settings/evidence-storage`
use schema version 1. POST contains `expectedRevision` and `configured`, a strict
`{ "backend": "local" }` or `{ "backend": "s3", "bucket": "...", "region": "...", "prefix": "..." }`.
Credentials, endpoints and local roots are not accepted. Responses are non-secret
and `Cache-Control: no-store`, with separate `configured` and `active` values and
`restartRequired`. Saving does not apply, restart or activate storage. Current
writes keep the captured adapter; historical reads and pending receipts retain
recorded destinations. A separately authorized startup may use the saved config;
full startup-selection and hosted proof remain open. Invalid existing settings
fail closed with `evidence_settings_invalid` (503), preserving the file bytes;
these controls do not accept unknown fields or infer legacy locations.

Paired devices use the same GET/POST `/v1/settings/evidence-storage` route through
the relay with current `terminalControl` authority and their original device
bearer. The relay validates the canonical update and snapshot schemas. Saving
changes only `configured`; `active` and `restartRequired` report the captured
backend until a separately authorized restart.

Self-hosted S3 uses the standard AWS SDK credential provider chain; credentials
are never settings. Managed evidence has an optional default-off runtime-provider
hook: active and historical adapters require an exact scoped broker grant and
refuse without it. It does not expose a credential-entry command or enable a
tenant. The private issuer is injectable and unmounted; production transport,
STS, startup and activation are not provided by the offline slice. Existing
settings, TUI and device authority are unchanged. Records and receipts remain
in SQLite, and switching backends does not migrate blobs.

Managed sessions renew on demand at half-life and are capped at 900 seconds and
host identity expiry. Restart requires fresh admission. Invalid or denied replies
invalidate the cache; transient failure may retain a previously admitted session
only with more than 60 seconds left. Signed GETs are capped at session expiry
and 15 minutes. Revocation does not end an already-started direct-S3 transfer.
Hosted proof, bucket/IAM/lifecycle/backups, startup and owner activation remain
gated separately; see [ADR 0297](adr/0297-hosted-evidence-uses-renewable-tenant-credentials.md).

The manual `evidence-credentials-s3.integration.test.ts` offline check starts an
owned MinIO child inside its governed test lifetime, with scratch HOME/XDG and
disposable credentials, and stops/removes it in teardown. Set
`EVIDENCE_OFFLINE_MINIO_BINARY` to the locally verified binary and
`EVIDENCE_OFFLINE_ISSUER_FIXTURE` to the private checkout's
`apps/fleet/test/fixtures/evidence-issuer.ts`, then name that test through
`clankie heavy -- pnpm exec vitest run`. It exercises the public CLI and HTTP
routes, production operator auth, isolated file broker, SQLite and private
injected issuer. Without both paths it is skipped. This proves offline
protocol/provider behavior, not AWS STS, IAM, cloud revocation or full startup.

The manual `apps/clankie/test/evidence-s3.integration.test.ts` check uses the
production SDK against a real, already-running loopback MinIO server. Start
that owned server through `clankie heavy --server`, with private disposable
HOME/config/credentials. Supply `EVIDENCE_S3_MINIO_CONFIG` as the path to its
private JSON binding (`endpoint`, `accessKeyId`, `secretAccessKey`), then run the
named test through `clankie heavy -- pnpm exec vitest run`. Without the binding
the check is skipped; it never starts infrastructure during ordinary CI. Stop
the owned server and remove its credentials/data afterward. This local check
does not establish hosted acceptance or exercise AWS credential renewal.

Uploads still use the service's signed PUT and JSON receipt API. The service
checks the full size and SHA256 before uploading to S3. Fetch resolves recorded
objects to fresh S3 GET URLs valid for at most 15 minutes (temporary credentials
may expire sooner); manifests keep only stable `clankie://evidence` links.

- `clankie evidence push [PATH] [--issue KEY] [--caption TEXT]` (default `.`)
  works only inside a declared evidence root (by default `docs/testing/<folder>`).
  Repositories may declare relative roots in `.clankie/evidence.json`, for example
  `{"roots":["docs/testing","artifacts"]}`. Outside one it
  refuses, names the roots and changes nothing. It hashes the in-scope files
  under `PATH`: media (png, jpg, gif, mp4, mov, webm) of any size, and any other
  non-Markdown file of 16 KiB or more. Smaller text, Markdown and
  `evidence.json` stay in git. It uploads only blobs the store lacks, then
  writes or updates the folder's `evidence.json`. That is the nearest one
  above `PATH`, or else the one beside the nearest `README.md`. The JSON
  reports `added` and `changed` entries with their `clankie://evidence/sha256/…`
  links, `uploaded`, `receipts` and `failures`. Each pushed raw file then
  moves to `.local/evidence/<repo-relative folder>/<path>`, which git ignores.
  A second push uploads nothing, leaves the manifest byte-identical and says
  `Nothing uploaded; … unchanged`. A listed file that is missing locally keeps
  its entry; removing one is an explicit manifest edit. Commit only the README
  and `evidence.json`, and cite the printed links in tracker comments.
  When `--issue` is omitted, push infers keys from the branch, then the worktree
  directory name, then the folder's README, and reports the source. An inferred
  key is a built-in key (`LOCAL-n`, or `LOCAL-VUH-n` once the store holds an
  imported team; one key, never its `VUH-n` tail) or carries the team key from
  `.clankie/tracking.json`; `SHA-256`, `UTF-8` or `GPT-6` never count. In a
  README, Linear issue URLs, headings and `Tracks:`/`Issue:` lines win over
  keys elsewhere in the text. If none is found, the record stays unkeyed. Multiple keys are stored separately in
  record metadata; the wire `issueKey` retains the first for existing clients. Issue lookups and
  recent filters match any key, including historical multi-key strings.
  On a fleet machine without Clankie's CLI (the Windows PC), the worker plugin's
  own `clankie evidence push [PATH] --issue KEY [--caption TEXT]` runs the same
  push over the pane's fleet link, with no operator credential (VUH-2923). It
  requires `--issue` and has no other commands; the worker bridge's
  `evidence_push({path, issue, caption?})` tool takes an absolute `path` and
  does the same. Records name the seat as their actor, with its worker name
  and lead.
- `clankie evidence backfill --database SQLITE [--repo PATH] [--apply]` repairs
  local SQLite records only. It opens the database read-only by default and
  prints proposed changes and before/after counts. `--repo` defaults to the
  current directory and must name a git repository root. Unkeyed records use
  the nearest folder README, then the most recent path-specific git commit
  naming an issue (up to 50 commits), by push's key rule. Records explicitly naming another repo
  are skipped; records without repo metadata are assumed to belong to this
  checkout. Review those proposals before applying. Existing multi-key strings
  become separate keys. `--apply` commits only record metadata in a transaction
  and refuses concurrent edits; blobs and upload receipts are untouched. Get
  owner approval after reporting the live dry run before using `--apply` on a
  live store. Apply only after deploying the service that reads separate keys.
  Repeat for other repositories with their own checkout.
- `clankie evidence fetch [PATH]` reads manifests at or above `PATH` within the
  declared roots, or
  every manifest below it. It downloads each listed object into
  `.local/evidence/<repo-relative folder>/<path>` and verifies its size and
  sha256 before moving it into place. Objects already present with the right
  hash are reported as `present`. A local file whose hash differs is reported
  and left untouched. Every object it cannot fetch or verify is named with its
  reason, and the command exits 1.
- `clankie evidence list --issue KEY | --commit SHA` returns the records
  (file name, sha256, size, content type, issue, commit, actor, caption,
  created-at, link).
- `clankie evidence list --recent` returns newest-first records across issues,
  with `nextCursor` when another page exists. Filters: `--project`, `--repo`,
  `--issue`, `--actor-kind operator|worker|seat`, `--actor-name` (name, or ID
  when unnamed), `--media-type` (image/video/text or an exact MIME type),
  `--since` and `--until` (inclusive ISO timestamps). Use `--limit 1..100`
  (default 40) and `--cursor` with the same filters for another page.
  Push accepts `--project`, `--repo`, `--model`, and
  `--outcome passed|failed|partial`; repo defaults to the Git remote URL.
  Older records retain unknown metadata; project filters cannot infer it.
- `clankie evidence receipt RECEIPT_ID` reads an upload receipt: `applied`,
  `pending` (with a fresh signed upload URL) or `refused` (`sha256_mismatch` or
  `size_mismatch`). It exits 1 for an unknown receipt.

The manifest is `{"version":1,"objects":[{path,size,sha256,url}]}`, sorted by
`path` (relative to the manifest, `/` separators), so a change is a one-object
diff. Uploads are idempotent. Push derives each receipt ID from the file's
repository path, its sha256, the HEAD commit, issue and caption, plus the
repo/project/model/outcome metadata. A
retried push therefore asks for the same receipt, and a lost answer is
reconciled by looking that receipt up, never by a blind resend.

The service side lives in `apps/clankie` and uses the operator bearer. Its
routes are `POST /v1/evidence/uploads`, `GET /v1/evidence/receipts/ID`,
`POST /v1/evidence/fetch` (`{sha256}` to a signed URL valid for at most 15
minutes), `GET /v1/evidence/records?issue=KEY|commit=SHA` and
`GET /v1/evidence/status`. `GET /v1/evidence/recent` accepts the same filters
as query fields (`actorKind`, `actorName`, `mediaType`, `since`, `until`,
`cursor`, `limit`). `GET /v1/evidence/preview/SHA256` returns a base64 raster
preview only for images at most 64 KiB; larger/non-image objects return
`available:false` with `too_large`/`not_image`. Both keep existing bearer auth.
Blob bytes move only through signed, expiring
routes. The store accepts a blob only after its sha256 and size match the
upload. Self-hosted blobs live under `~/.clankie/evidence/blobs`, keyed by
sha256, with records in `~/.clankie/evidence/evidence.sqlite`. `clankie doctor`
reports both as `evidenceStore`. The operator seat's `clankie mcp` exposes the
same operations as `evidence_push`, `evidence_fetch` and `evidence_list`. Hosted
Clankie does not offer these commands yet.

`pnpm testing:view [docs/testing/FOLDER] [PORT]` serves the archive locally
(default port 4173). Open `/?recent` for the day-grouped feed, or
`/?issue=VUH-1903` for full-screen issue evidence. Feed rows open that issue;
J/K and arrows move, Enter opens, Esc returns, and / focuses the filters.
The item viewer supports swipe, images/video, text/terminal captures and a
collapsible JSON tree. It shows provenance and copies the content link.
Gaps come from the local README's Gaps/Limitations/Unproven sections for the
issue's recorded paths; unavailable gaps are explicitly labelled.
The archive reads pushed files from `.local/evidence`, fetching a missing
manifest folder on demand with the existing verified fetch command. Store
reads use the operator broker credential on the local server; it never reaches
the browser. `CLANKIE_CONTROL_PLANE_URL` (or `CLANKIE_CAPTAIN_URL`) selects the
store. Larger feed images use a placeholder until opened.

### `operator-credential rotate [--json]`

Mint a new local operator bearer. Existing operator sessions are invalid
immediately. JSON: `{ "ok": true, "status": "rotated", "source": "store" }`.
The new secret is not printed.

### `operator-credential protect [--json]`

macOS, from the owner's own terminal. This moves the operator bearer out of
the login keychain into Clankie's protected keychain,
`~/Library/Keychains/clankie.keychain-db`, which isn't on the search list. A
random unlock password for it lives in the login keychain. The token is
unchanged, so running sessions keep working, and the login copy is deleted only
after the protected copy reads back. Hired workers under the worker sandbox
can't read the protected keychain. JSON:
`{ "ok": true, "status": "protected"|"already_protected", "created", "moved" }`.
Refused from a hired worker pane. Run it only once worker CLI commands no
longer need the bearer (VUH-2837); until then a worker's `evidence push`,
`simulator` and `work` stop working after protection.

### `play status`

The live embodiment session (`GET /v1/embodiment/sessions/live`). JSON
`{ "session": … }` or `{ "session": null }`. Requires an operator credential;
start the clankie service once if none exists.

### `play stop`

Operator kill-switch (`POST /v1/embodiment/sessions/live/stop`). The play host
winds down at the next turn boundary — this is not a process kill. A live
session returns JSON. Idle is the sentence `Nothing is playing.` (exit 0, not
JSON).

### `play guide TEXT --conversation CONVERSATION_ID`

Suggest an objective or approach to the live Pokémon mind. The authenticated
`POST /v1/embodiment/sessions/live/guide` accepts `{text, conversationId}` and
checks the selected conversation's play ownership again before queueing it.
Clankie can use `pokeagent_guide` from that conversation; the mind still chooses
its objective and actions. This does not start a sitting or affect another game.

### `minecraft`

`minecraft host status|start|stop|restart|backup` manages the integration-owned
Paper server. Hosting is off by default, stops after 15 minutes with no players,
and has a six-hour maximum requested-run uptime. `host configure` reads its
settings; `host configure JSON` updates stopped-server resource, backup and
idle/uptime settings. The `backend` field selects `{"kind":"local"}` or the
pre-provisioned AWS EC2 backend (account, instance and region); see [AWS setup and cost controls](minecraft.md#aws-hosting-and-cost-controls).
AWS starts use a scoped broker credential and SSM, and stop must confirm the
instance is stopped. `host admin JSON` accepts typed administration; `host approve
USERNAME` approves an existing verified Discord request. No op, raw RCON or
account-secret arguments are accepted. `host tunnel claim` starts a background
agent build/claim job and returns quickly with its phase. `host tunnel status` reads its
phase and the approval URL when ready. The integration polls playit every three seconds
and sends browser approval straight to the broker even after the CLI exits;
`host tunnel complete` also reads status. This Mac builds pinned playit source during setup and requires Cargo.

`minecraft configure PROFILE HOST --version VERSION [--port PORT] [--username NAME]`
adds an offline Java server profile. `configure` shows settings; `configure remove PROFILE`
and `configure allow-public|revoke-public HOST [PORT]` manage destinations.
DNS/SRV targets are resolved and checked before dial; public endpoints require an
owner allowlist. Clankie’s setup tools can configure profiles for owners/individual
operators; gameplay tools select approved profile ids.

`minecraft configure play` reads the default play loop settings. Flags update
them without changing profiles or destinations:

```sh
clankie minecraft configure play --model openai/gpt-4.1-mini --max-tokens 100000 --max-cost-usd 1
clankie minecraft configure play --turn-interval-ms 2000 --idle-backoff-ms 15000 --idle-stop-ms 900000
clankie minecraft configure play --enabled off
```

Play is enabled by default with the model and limits shown above. The token and
reported cost ceilings are per mind run; reaching either stops further decision
calls. Model, budget and pacing changes apply on the next join or handoff back to
the mind. Disabling play quiesces the current mind. The existing authenticated
`GET`/`PUT /v1/minecraft/configuration` API carries these same fields in `play`
alongside the full profiles and allowlist configuration.

`minecraft driver` reads who currently drives the session. `driver mind` returns
it to Clankie's play loop; `driver owner` takes direct control for the owning
conversation; `driver worker fleet:FLEET:pane:SEAT` hands it to that exact hired
native seat. Direct actions require the selected owner or worker driver. In the
TUI, `/minecraft driver` shows the current driver and a selector with a worker
principal prompt; `/minecraft configure play` exposes the same settings flags.

`minecraft status|profiles|join PROFILE|leave|cancel [ACTION]|pause|resume|observe`
manages the session. `chat TEXT`, `follow PLAYER [DISTANCE]`, `goto X Y Z`,
`dig X Y Z`, `place X Y Z ITEM`, `craft ITEM COUNT`, and `action JSON` return
prompt action handles; `action-status ACTION` separates settlement from server
evidence. All return JSON. Use `--conversation ID` to select an existing owning
conversation. `/minecraft` exposes the same controls and settings in the TUI.
Minecraft and Pokémon share one play lease, released only after confirmed
disconnect. See [Minecraft setup and limitations](minecraft.md).

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

The JSON `display` array gives plain provider/model, funding, automatic routing and explicit unavailable-rate information from the same API. Restore a prior eligible preference with `model set provider/model`; input/output/cache credit rates remain unavailable while their policy is open.

### `model add-local --id ID --base-url URL [--context N] [--models id,id] [--set]`

Declare a credential-less OpenAI-compatible local runtime (ds4, Ollama, LM
Studio, vLLM, llama.cpp) into global `clankie.json`. The TUI
`/provider` → “add a local endpoint…” flow uses the same writer.

| Flag         | Meaning                                                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--id`       | Provider id. Lowercased. Letters, digits, `.`, `_`, `-`; no slashes.                                                                                |
| `--base-url` | `http://` or `https://`. A bare origin is rewritten to `/v1` (`http://127.0.0.1:8000` → `http://127.0.0.1:8000/v1`). Trailing slashes are stripped. |
| `--context`  | Fallback context window in tokens when the probe does not report one. Default `131072`. Must be a positive integer.                                 |
| `--models`   | Comma-separated model ids used when the probe returns nothing.                                                                                      |
| `--set`      | Select the first listed model as captain (`providerId/firstId`).                                                                                    |

The probe is `GET {normalizedBaseURL}/models` with a 3-second timeout. Local
runtimes are unknown to models.dev, so the endpoint itself is the catalog. A
model the list gives no context length (Ollama's `/v1` never does) is asked
again at Ollama's native `POST /api/show`, which reports the model's own window;
other runtimes leave it at `--context`.

Ollama can serve a smaller context than that native window: `num_ctx` comes from
a Modelfile `PARAMETER num_ctx`, `OLLAMA_CONTEXT_LENGTH` or a default sized to the
machine's memory, its `/v1` route ignores a requested size, and it silently drops
the start of a longer prompt. Before each turn Clankie reads the context Ollama
has loaded the model with (`GET /api/ps`, loading it first with `POST
/api/generate` if needed) and narrows the window to it. When his instructions and
tool schemas alone do not fit, the turn fails with that reason instead of being
truncated; raise `num_ctx` or pick a larger model. His first request on a fresh
install is about 26k tokens, so give a local model at least 64k.

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

Select an eligible preference through the running service's authenticated
`/v1/model-settings` API. The ref splits on the **first** slash (model IDs may
contain slashes). Changes apply to new turns; restore the previous ref with the
same command. JSON: `{ "ok": true, "model": "xai/grok-4.6", "restart": "applies to new turns" }`.
`model status` includes the shared `settings` response with actual identity,
funding, availability and automatic routing targets. Missing hosted identity
remains unknown. See [model settings](model-keys.md) for compatibility and open
provider/credit policy.

### `model subscriptions [list|methods|start|status|cancel]`

Use the running local service's subscription sign-in jobs through the same API
as paired devices. `list` reports existing sign-ins; `methods` reports the
allowed providers and browser/device choices. Start requires a catalog model:

```sh
clankie model subscriptions methods
clankie model subscriptions start openai-codex --method browser --model "openai-codex/<catalog-model>"
clankie model subscriptions status <session-uuid>
clankie model subscriptions cancel <session-uuid>
```

JSON includes `ok`; a job also includes its ID, expiry and state. A pending
status can include a sensitive browser URL or device code: open it from the
owner's terminal, never copy it into reports or logs. A completed job stores
credentials in the service broker, selects the requested model and updates
shared readiness without a restart. Only the initiating principal can read or
cancel its job. Requests have a ten-second deadline and never retry an uncertain
start. Provider/transport errors return fixed codes, without raw error text.
Claude subscription sign-in remains unsupported. To talk to Clankie on the owner's
Claude plan, use [`clankie claude`](#seat-commands), which runs Claude Code under
its own sign-in. See [model keys](model-keys.md)
for the API, hosted policy and first-run Mac key-entry guard.

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

These compatibility controls configure eligible targets; Clankie makes the
per-turn decision through `escalate`. Targets cannot cross the saved provider
preference. A preference change takes effect on the next turn. Authenticated
conversation events report each provider attempt's serving identity and reported
tokens, and record refused/unavailable routing decisions. Requested aliases and
selected targets are intent, never proof of the served model. See
[model settings](model-keys.md) for the shared event contract and open charge linkage.

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
supported levels from Pi and calls this writer. Paired apps read and set the running
model's effort through the [owner model-key API](model-keys.md).

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

`google/veo-3.1-generate-preview` (or the `-fast-` and `-lite-` Veo models) is
the frames-to-video provider; its key is set once with
`clankie keys set google --key-stdin`. A render with frames goes to Veo even
when `video_model` names another provider, unless it already names a Veo
model. Prompt-only video keeps the configured model.

`POST /v1/media/videos` (and his `generate_video` tool) takes `prompt`, plus
optional `firstFrame`, `lastFrame` (needs `firstFrame`), up to three
`referenceImages`, `aspectRatio` and `durationSeconds`. Each picture is an
`artifactRef` he made or a PNG, JPEG or WebP data URI. The same picture as both
frames makes a seamless loop; Veo renders a last frame or reference images at 8
seconds only. A `pending` result is resumed with `requestId`
alone. Fleet workers call `clankie_generate_video` through `clankie_call`. On
this machine they may pass absolute image paths, and an `ok` result adds the
video's local `path`.

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

| Flag                    | Value                                                                                                                                                                                           |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--display-name`        | 1–64 characters                                                                                                                                                                                 |
| `--aliases`             | Comma-separated names; `none` clears                                                                                                                                                            |
| `--character-notes`     | Up to 4,000 characters                                                                                                                                                                          |
| `--chattiness`          | `quiet`, `balanced`, or `chatty`: how readily he joins in when nobody addressed him (Discord and stream rooms, not the operator lane). Never a length limit; once addressed he answers normally |
| `--reply-policy`        | `addressed` (an @mention or one of his names) or `all`                                                                                                                                          |
| `--live-message-window` | Whole number from 0 through 100                                                                                                                                                                 |

JSON contains `{ "ok": true, "persona": { … }, "settingsFile": "…", "restart": "clankie restart captain" }`.
The TUI `/persona` modal calls this same writer.

### `desktop [status]` / `desktop quiet-hours START END TIME_ZONE|off`

Read or set desktop quiet hours. Times use `HH:mm` and an IANA time zone,
for example `clankie desktop quiet-hours 22:00 07:00 America/Chicago`.
Overnight ranges are supported; the start is inclusive and the end exclusive.
Equal start and end times are rejected. `clankie desktop quiet-hours off`
removes the range. The TUI `/desktop` takes the same arguments. Changes apply
immediately without restarting. JSON returns `desktop` and `settingsFile`.

The captain's `desktop` tool can emote, move within the current display using
normalized coordinates, or show a short bubble. Expressions carry a unique ID
and expiry in `presence`; they last five seconds by default, up to thirty.
Quiet hours suppress them without changing the source-derived mood. Desktop
clients also honor macOS Focus, discard expired expressions, and show them
without taking keyboard focus. Publishing does not confirm a client displayed it.

### `games extensions`

Read registered game extensions through owner-authenticated
`GET /v1/games/extensions`. The TUI uses `/games extensions`. JSON contains each
extension's connector kind, skill, settings key, Activity surface, local lifecycle
state and health. The command never joins a game or calls a model. `ready` is local
lifecycle health; it does not prove a reachable world or visible stream. An
uncertain connector remains registered until exact host recovery proves it ended.

`games extensions add MODULE [KEY=VALUE...]` installs a game extension that lives
outside this repository, such as Rivals Agent's Spider-Man bridge, by its absolute
module path; running it again replaces that module's options. `games extensions
remove MODULE` uninstalls it. Both write `gameplay.extensions` in the settings file,
print the same JSON as `games status`, and apply on `clankie restart`; the TUI
accepts `/games extensions add|remove ...`. Options are non-secret values for the
module; store any credential it needs with `/auth`. A module that fails to load is
logged as `game_extension.module_unavailable` and skipped without affecting other
games. The module contract is in [`packages/game-extension`](../packages/game-extension/README.md).

### `games [status]` / `games set on|off` / `games budget`

Read or set whether the PokeAgent MMO body is available. JSON contains the
`games.pokeagentMmoEnabled`, optional `games.pokemonBudget`, `settingsFile`, and
`"restart": "clankie restart"`. The TUI `/games` exposes availability and token/cost
caps using the same writer. Restart to apply defaults to subsequent sittings.

```sh
clankie games budget max-tokens 250000
clankie games budget max-cost-usd 1
clankie games budget max-cost-usd default
```

`max-turns` and `max-duration-ms` accept positive integers too. `default` removes
an override. Pokémon defaults to 250,000 charged model tokens, including
commentary and interrupted decisions; turn/duration and dollar caps are optional.
The authenticated `GET`/`PUT /v1/games/configuration` reads/replaces this gameplay
configuration. Embodiment start intents can override these defaults with `budget`.

Journals record input/output tokens, charged tokens, model calls and estimated
USD on each turn and the summary. A metered call without usage reserves 16,000
charged tokens and marks cost unknown; a dollar-capped session then stops. Caps
are checked between calls, so the last call can exceed a threshold. Cost is an
estimate from registry prices, not an invoice. Terminal receipts name
`budget_exhausted`, `mind_unavailable`, `world_ended` or `stopped`.

### `browser tools` / `browser call TOOL JSON`

Each conversation browses concurrently in its own tabs and workspace. Calls
serialize within that conversation. The shared profile retains Clankie's logins;
`isolated: true` opens a logged-out context. A call without machine authority
(a captain bearer, or a social or voice turn) always browses logged out and only
on public http(s) addresses; anything else returns `doctrine_denied`. Close/60-second idle cleanup affects
only that conversation, with no browser body lease or recovery hold. One service
owner launches and recovers Chrome; a headed mode change is unavailable while
other conversations browse.

Inspect or call Clankie's Browser Use Pi tools with the operator credential:

```sh
clankie browser tools
clankie browser call browser_use_open '{"url":"https://example.com"}' --conversation CONVERSATION_ID
clankie browser call browser_use_javascript '{"code":"console.log(await page.info())"}' --conversation CONVERSATION_ID
clankie browser call browser_use_close '{}' --conversation CONVERSATION_ID
clankie browser call browser_use_open '{"isolated":true,"url":"https://example.com"}' --conversation CONVERSATION_ID
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
clankie body request '{"action":"queue","resource":"browser","conversationId":"CONVERSATION_ID","request":"Notify me when the browser is free","ttlMs":300000}'
clankie body request '{"action":"ask","resource":"voice","conversationId":"CONVERSATION_ID","request":"Can you finish this voice stay?","ttlMs":300000}'
```

`computer` ownership is exposed separately through `clankie computer request`
and `/v1/computer`; the legacy body status resource set stays unchanged.

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

For `recovery_required` voice, play and Discord mouth leases, the
service tries the same verified stop-check automatically at boot, then retries
with backoff from 5 seconds up to 60 seconds. It requires a known service-owned
holder whose turn and body operations have ended, and checks both again across
awaited work. Missing or unreadable holder metadata and native-owned turns
require explicit owner recovery; native display activity does not prove completion.
Only confirmed termination releases the exact lease incarnation. Refused or
unavailable stop proof keeps the lease held; computer recovery stays in its
separate contract. If recovery persists, the owner can inspect `clankie body
status` and explicitly recover from an existing writable conversation:

```sh
clankie body request '{"action":"recover","resource":"browser","conversationId":"CONVERSATION_ID"}'
```

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

The configured computer-use harnesses here and on linked Windows fleets for hard
computer and browser work
([ADR 0199](adr/0199-hard-computer-work-goes-to-a-computer-use-harness.md)).
`harnesses` asks the service (`GET /v1/browser/harnesses`, operator bearer),
which re-probes on every read: `codex login status` and `codex features list`
plus Codex's plugin config for Codex computer use and Chrome, and
`claude auth status` plus `~/.claude.json` and Chrome's native host for Claude
in Chrome. Nothing is started or driven. JSON contains `detected` (false on a
hosted body, where owner-machine probes are not configured), `harnesses` (each
with `harness`, `signedIn`, `surfaces` of `desktop` and/or `chrome`,
`chromeNeedsHireFlag`, and `missing` saying what the owner does when it is not
ready), optional `platform` and fleet `machineId`, and `harnessDelegation`.
Windows probes read Codex login, flags and its installed Windows plugin; they
report signed-out and disabled installs. App grants and successful input remain
separate live proof.

`delegate on|off` sets `browser.harnessDelegation` (default on): whether the
ready harnesses appear in the `reach` section of his prompt, on lanes with
machine access only. Turn it off to keep him from spending those plans. His own
browser is unaffected. JSON is the `browser status` shape with
`"appliesTo": "next_session"`. `/browser harnesses` and `/browser delegate on|off`
in the TUI call the same code. A listed harness is hired with `hire_agent`;
`chrome: true` starts claude with `--chrome`.

<a id="review"></a>

### `review list|show|status|waive`

The owner's side of the standing review gate
([ADR 0287](adr/0287-a-standing-reviewer-gates-every-landing.md)). A project may
name a reviewer (`project settings PROJECT --reviewer-role ROLE`, below). Authors
submit and reviewers decide from their own seats with the worker tools
`submit_for_review`, `review_candidate` and `review_verdict`
([worker access](worker-access.md)). These commands use the operator credential,
except `submit`. They never record a verdict.

```sh
clankie review submit --checkout DIR --summary TEXT [--issue KEY] [--evidence URL]... [--base REF]
clankie review list [--project ID]
clankie review show ID [--patch]
clankie review status [--directory DIR] [--base REF]
clankie review waive --reason TEXT [--directory DIR] [--base REF]
```

- `submit` is the author's `submit_for_review` for a seat whose catalog lacks the
  tool: a harness without the review tools, or a bridge started before them. Run
  it in the author's own fleet pane. The pane's fleet link proves the author
  exactly as the tool does, and the operator credential plays no part. It takes
  the same absolute `--checkout` and prints the same candidate and `read` echo.
- `list` prints the candidates, newest first, optionally for one project.
- `show ID` prints one candidate with its status, files, evidence, verdict and
  any waiver. `--patch` adds the stored patch text.
- `status` hashes the checkout's committed change (`git diff --binary`
  from the merge base with `--base`, default `origin/main`, to `HEAD`) and asks
  whether that exact patch may land. It prints the landing record and exits 0
  when the patch is landable: the project names no reviewer, or the patch is
  approved or waived. It exits 1 while the patch is awaiting review, has
  CHANGES or was never submitted, and when the service has no review routes.
- `waive --reason TEXT` records that this exact patch lands without review. The
  reason is required. The candidate keeps who waived it, why and when, and
  verdict readers show it. The lead has the same power through its
  `waive_review` tool. Both are rare.

`check:landing` runs `status` after green checks. If review is pending or the
service cannot answer, it records
`checksExitCode: 0` and exits 3. `pnpm check:landing --revalidate` carries those
green checks forward when only `main` moved, asks about review again and exits 3
while it is held; exit 0 means push, exit 1 means rerun the gate. A rebase that
changes the patch changes its hash and needs a new review. A live verdict that
names no reviewer needs no approval. An unavailable service may be skipped only
in external CI without owner settings; integrate always holds on a missing verdict.

<a id="fleet-resource-governor"></a>

### `heavy [--server] [--seat LABEL] [--holder ID] -- COMMAND [ARGS...]` / `fleet resources` / `simulator`

`heavy` runs a local command inside the shared OS-account resource governor.
Its child environment caps Vitest workers and Turbo tasks at four through
`VITEST_MAX_WORKERS` and `TURBO_CONCURRENCY`, preserving lower positive integer
environment limits. This reaches package scripts and nested commands. Turbo's
strict task environment must pass these variables through; this repo does.
Higher Turbo CLI concurrency and `--parallel` override its environment limit;
keep those within four. Other tools still need their own parallelism limits.
It preserves child arguments, exit status and signals. Keep installs, compilers,
test suites, builds and entire owned runtime lifetimes inside the wrapper, and
serialize multi-package compilers with `--workspace-concurrency=1`. Native local
hire briefs include this contract automatically. Nested verified commands reuse
the same permit; surviving descendants retain it after a wrapper exits.

`heavy` sizes each command itself. A focused check — Vitest naming up to eight
test files, `tsc` without `--build`, or `pnpm --filter ONE typecheck` — runs in
the light lane: its own journal under `light/`, as many slots as the base heavy slots,
two cores per job (the same variables capped at two), held only by the memory
floor, so it starts beside full gates even at high load.
File-scoped Oxfmt and Oxlint runs also use the light lane (up to 64 existing
files). Use `clankie heavy -- pnpm exec oxfmt --check FILE...`,
`clankie heavy -- pnpm exec oxlint --deny-warnings FILE...`, or the root
`pnpm fmt`, `pnpm fmt:check` and `pnpm lint` scripts with explicit files.
Those scripts honor the file selection; their argument-free forms retain whole
repository and native checks. Direct tool threads are capped at two in a light
permit, preserving a lower explicit limit. Directories, globs, missing files,
unknown flags and type-aware linting keep the full lane.

Expo start, `pnpm dev`, Vite/Next dev and recognized watch commands select the
separate server lane. Custom long-lived services use `heavy --server -- COMMAND`;
an opaque shell command otherwise remains a full job. The server lane has up to
two slots, sharing 20% of machine CPU cores (at most 64 cores), divided equally
among the slots. Its native supervisor samples aggregate owned-group CPU every
100 ms and pauses/resumes proven process lifetimes to pay back excess usage;
brief bursts can exceed this sampled budget. Tool-native fan-out is capped at
two. Kernel-proven Darwin zombies are skipped before their parent reaps them.
Unknown CPU observations resume the owned group and report degraded enforcement;
its server permit stays held. CPU may exceed its share until observation recovers,
when accounting restarts from a fresh baseline.
`serverLeases[].cpuLimitUnenforcedSinceMs` exposes degradation in resource JSON;
doctor displays "CPU limit not enforced", with a warning after one minute. The
supervisor also warns after one minute and then every five minutes, retaining
the server permit and restoring progress throughout.
Detached or privileged children are outside this process-group contract.
Servers still wait on machine load, memory and FIFO in their own journal under
`server/`; they hold no build/check slots. Stop them when finished. A server
inside a bounded job gets its own permit rather than borrowing the parent's.
Verified nested servers under a server parent reuse its governed permit.
An older installed arbiter does not govern this lane; new server waiters judge
its admission themselves until the service advertises server-lane support.
Brief registry-lock contention waits internally without discarding the queue
ticket. Actual native failures identify their cause; see the
[resource governor reference](../packages/fleet-resources/README.md).

`fleet resources` returns current capacity, pressure, holders and queue as JSON.
The service alerts when a lane head remains queued over 60 seconds despite
consecutive sampled verdicts permitting admission. The alert names the ticket,
owner seat, holder and PID, including an absent grant marker. Pressure and
capacity waits do not alert; unavailable observations do not prove recovery.
Opening and recovery notices are durably deduplicated. No automatic repair,
requeue or registry edit is performed. Granted-but-not-started leases are outside
this queue-head detector.
`capacity.used` counts heavy leases against `heavySlots`; `simulatorUsed` counts
simulator reservations against `simulatorSlots`; `lightUsed` counts light-lane
jobs against `lightSlots`, whose holders and waiters are `lightLeases` and
`lightQueue`. When no full lease is held, the FIFO head may start despite a
load-only refusal if native observation is valid, memory meets the owner floor,
and load stays below twice `maxLoadRatio`. At or above that cap it still waits.
Between the normal load guard and the cap, exactly one full job at a time can
make progress; starting, running and cleanup full leases count as held. Light
and server jobs use separate budgets and do not count. Low memory and unavailable
observations still refuse admission. Simulator cold-boot guards remain unchanged.
`heavySlots` is a ceiling: one job per four cores runs on the
load guard (each job started in the last minute counts four cores of load), and more start only while measured CPU and load stay under 70% of
the cores (a waiting `clankie heavy` says `busy`). Simulator status also reports
external active devices against the simulator budget. The budgets are independent;
load and available-memory guards gate both.
Server status adds `capacity.serverSlots`, `serverUsed`, `serverCpuCores`,
`serverLeases` (with each holder's `cpuCores`) and `serverQueue`. `holderAlerts`
identifies governed servers and build/check permits held over 15 minutes by
lane, seat, holder, executable and creation time. Waiting commands show these
holders, and the service notifies their owning lead through the existing fleet
alert channel only after 15 minutes, once per lease across concurrent refreshes
and service restarts. Definite undelivered notices retry; uncertain delivery or
a crash retains the persistent claim to prevent duplicates. Age never kills a
bounded job; explicit interruption and command-exit leftover cleanup retain
their existing behavior. The additive status fields are absent on older servers.
The operator fleet snapshot also carries recent confirmed native peer exchanges
in `edges`: `deliveryId` is the original native delivery UUID and `text` is up to
1,000 verbatim characters. Attempts, uncertain receipts and next-turn storage
produce no exchange. `leadVisits` separately records confirmed captain messages
and native pane closures; Clankie is not inserted into the worker roster. Both
windows hold at most 64 events for five minutes and start empty after restart.
These are delivery/action facts, not proof of task completion.

The operator fleet snapshot carries the cached `resources` field; the TUI
`/status` and `/doctor` show holders by seat label or actual PID. Sampling does
not run on `/health`. Resource metadata contains no arguments or credentials.

The owner sets `fleet.resources` with these flags or the TUI `/fleet resources`:

| Flag                                      | Default | Meaning                                                                               |
| ----------------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `--heavy-slots auto` or `--heavy-slots N` | `auto`  | Heavy ceiling, 1–64; auto is min(floor(cores/2), floor(RAM GiB/12)), at least one     |
| `--simulator-slots auto` or `N`           | `auto`  | Simulator ceiling, 0–64; auto is min(floor(cores/4), floor(RAM GiB/68)), at least one |
| `--simulator-idle-seconds N`              | `600`   | Lease heartbeat timeout, 1–86400 seconds                                              |
| `--max-load-ratio N`                      | `1.5`   | Maximum load average per core, greater than zero and at most 16                       |
| `--minimum-free-memory-mb N`              | `4096`  | Minimum OS available memory, 0–1048576 MiB                                            |

Free disk is sampled on the working-directory and OS-account home volumes.
Doctor and the lead's fleet round warn below either 200 GiB or 10% free.
All new heavy jobs (full, light and server lanes) wait below 20 GiB free;
existing jobs keep running. An unavailable disk observation refuses admission.
Set `minFreeDiskGb`, `warnFreeDiskGb` and `warnFreeDiskPercent` through the
revision-guarded fleet settings API, `/fleet resources`, or
`clankie fleet set --minimum-free-disk-gb N --warn-free-disk-gb N --warn-free-disk-percent N`.
Values are in GiB despite the CLI's `-gb` spelling. These guards also apply to
simulator admission, but do not stop existing leases or deny low-load social turns.

Available memory on macOS is the smaller of the kernel's
`kern.memorystatus_level` percentage of RAM and free plus file-backed resident
pages, excluding speculative pages already counted as free. Anonymous and
compressed pages are not counted as immediately reclaimable headroom. File
cache may require disk I/O to reclaim, so this remains an estimate. The native
boundary reads both directly and shares a one-second cache across
pressure samplers; a failed refresh or invalid observation refuses admission. Linux
retains `MemAvailable`, and other platforms retain free memory.

CLI edits update the journal immediately; API edits are reconciled by the body
within its five-second refresh. High load or low memory delays queued heavy work
and simulator leases. A new local hire is refused, with a reason, only when
available memory is below its floor; at high load it starts, and its receipt's
`resourceNotice` says its heavy work will queue. Existing accepted agents keep running. Missing
Python 3, helper or pressure observations refuse resource admission while the
body remains available. The canonical registry is the OS user's
`~/.clankie/fleet-resources`; worker environment and settings-path overrides do
not create independent capacity. See the [shipped skill](../.agents/skills/fleet-resources/SKILL.md).

`simulator acquire JSON [--wait SECONDS]` accepts `seatId`, optional `fleet`, and
a stable task `holderId` (automatically supplied by supported native harnesses),
`deviceType` and `runtime`, or `deviceId` to lease an existing device such as
one the seat booted by hand, and optional `exact`. The host proves the current
local seat and occupant, then leases an idle existing device of that type, a
close model, then any idle iPhone or iPad of the same family on that runtime
unless `exact`, or creates and boots a new one,
and records its exact UUID. Acquire persists one FIFO ticket and blocks on it,
by default for up to an hour. `--wait SECONDS` bounds that one service request;
`--wait 0` returns an immediate `waiting` ticket receipt. The CLI does not poll
acquire. The API accepts `waitMs` and optional `ticketId` to resume a bounded wait
with the same selection. Busy exact devices wait for that device, and matching
model requests resolve an existing target rather than creating a replacement.
The ticket survives service restarts and records the proven seat/occupant/holder,
selection, exact flag and creation time. `fleet resources` shows its target,
per-device position, expiry and `estimatedWaitMs`: an idle-budget heuristic that
heartbeats can extend, or null under pressure/unknown conditions. Other device
queues and heavy admission remain independent.

The seat is proved live on every request; nothing is stored that a restart could
drop, so no re-adoption is needed. A failed observation (native observation fails
in bursts under load, as right after a service restart) is retried briefly before
the first proof refuses. A waiting acquire keeps its ticket through failed
observations for up to two minutes, and an admitted lease survives one during
preparation. Only a proven change of occupant or an exited process ends the wait
at once. `owner_unavailable` names the observation's cause and the fix: retry the
same request.

`simulator cancel JSON` accepts the same seat/fleet/holder and ticket `id`.
Only that holder can cancel; cancel before changing its selection. Active waits
renew a five-minute stale deadline. Expired tickets and proven dead native owners
leave the queue; unknown observations do not establish exit. A ticket is not a
lease and never authorizes driving a device. An ended bounded wait can resume its
ticket before expiry. A disconnected or aborted HTTP wait keeps that ticket and
its FIFO position until stale expiry; use `simulator cancel` to leave the queue.
The CLI gives blocking acquire its own headers/body timeout covering `--wait`
plus response time, so the transport's five-minute default cannot end an hour-long
wait. Transport failures name their native cause; acquire is never silently
retried. Once admitted,
the service keeps booting and retains its lease even if the caller disconnects.
Results include `acquired`, `booting`, `waiting` with ticket/blockers/hint,
`cancelled`, and `rejected` with its cause (`service_restarting` is HTTP 503).

`simulator touch JSON` and
`simulator release JSON` accept `seatId`, optional `fleet` and `holderId`, and lease `id`.
`simulator verify JSON` accepts the same seat/fleet/holder, lease `id` and
`deviceId`. It checks the live native occupant, exact owned device and booted
state without acquiring or touching a lease. Use it before install, launch and
drive operations; refuse means stop that operation. Raw simctl, Xcode and external
MCP calls must invoke this preflight themselves; this API cannot intercept them
or make their later command atomic. Native Claude Bash hooks provide each
subagent's session/agent metadata in a command-scoped subshell; Codex uses its
executing thread. Automatic holder resolution ignores inherited holder labels. Explicit task holder arguments retain precedence.
The CLI validates successful acquire/verify grants against that holder and the
requested device. A different exact selection cannot reuse an existing lease or
a concurrent acquire result. Busy explicit UDIDs wait without substituting another
device. Worker plugin 0.6.11 and doctor/setup checks identify profiles missing the
resource hook; new hooks need the session's native reload to affect existing seats.
`simulator status` lists leases and external devices with the processes and
seats that name them; `clankie doctor` shows the same. The operator credential
is required; native occupant, process proof and binding fields are rejected as
caller input. Release, idle expiry or proven seat exit shuts down the leased
device and retains it for reuse, including one Clankie created. So does a
settled `runaway`: past its three-minute boot window, an untouched device holding
four cores for two minutes while the host is refused for load or memory. Each
settlement's reason is appended to `simulator-settled.jsonl` in the resource
registry. A later touch, verify or release of an `idle`, `runaway` or
`owner_exited` lease answers `lease_unavailable` with that reason. Deletion is a
separate explicit owner tidy of exact stopped UDIDs. External booted devices count
toward the ceiling and are never shut down; the lead of a seat using one is
told once. Unknown receipts remain held for review; observer shutdown does not
release them. See [ADR 0249](adr/0249-simulator-leases-answer-promptly-and-name-their-holders.md).

Within the requested family and runtime, a valid native `lastUsedAt` timestamp
puts previously booted devices ahead of devices with unknown boot history,
even when the latter match the requested model exactly. Among those candidates,
exact model then close model then family determines preference. `exact: true`
never substitutes a different model; an explicit `deviceId` remains strict.
Missing or malformed metadata is unknown, never proof of a previous boot.

Native Claude Bash hooks supply a holder from their session and subagent ID;
Codex uses its executing `CODEX_THREAD_ID`. Claude hooks supply
`CLAUDE_SESSION_ID` and `CLAUDE_AGENT_ID` alongside the compatibility
`CLANKIE_RESOURCE_HOLDER`. The CLIs derive automatic identity from native
metadata; a raw inherited holder alone is ignored. Hired panes clear these
fields before their own harness starts, even if Herdr inherited a lead's
environment. Dedicated Codex servers execute tools outside the TUI pane and
clear the service's inherited identity at their own launch boundary too.
Worker plugin 0.6.18 and operator plugin 0.3.7 carry this scoped
metadata; existing sessions need a native hook refresh.
Heavy commands accept `--holder ID`; simulator JSON accepts `holderId`, which
must stay the same for acquire, verify, touch and release. Missing task metadata
refuses acquire/plan instead of falling back to a seat-level lease. A different child holder
cannot inherit or release the lease. Status lists that holder beside the seat.
These labels never replace native seat proof or grant cleanup authority.

Leases retain verified activity for the exact holder: fresh native turn state or
same-holder queued/held heavy work with proven native process ancestry. Idle
expiry counts from returning to the prompt; repeated idle readings do not renew
it. Explicit touch still works. Unknown/stale observations cannot preserve a
cached working state. Native turn coverage is Codex roots/children and Claude
local children with the original-native activity mod; Claude root turn-only
renewal remains unproven/unsupported because its API does not identify root turns.
Those roots and other unsupported native paths need exact-holder heavy work or
explicit touch. Run waits/fallbacks outside model turns and release on completion.
See the [simulator reference](../.agents/skills/fleet-resources/reference/simulators.md)
for finite native evidence and cleanup guards.

Simulator leases in `fleet resources` and `simulator status` carry optional
`usage`: timestamp, availability, process count, `footprintBytes`, `rssBytes`,
CPU time and, after two observations, interval `cpuPercent` (100% is one core).
The charge belongs to that lease's task `holderId`. Footprint includes private
compressed memory; RSS includes shared pages and is not an extra charge.
Partial/failed reads are marked and never mean zero usage. Unleased devices
also show usage in simulator status. Samples are diagnostic, cached up to five
seconds, and cannot authorize driving or releasing a device. Machine admission
already includes that cost in its load and memory sample; it does not subtract
the footprint twice.

`simulator plan JSON` gives read-only creation/reuse advice and the current idle
timeout. Acquire reads that plan before its native request, warns on stderr
when creation is needed and its first boot can be expensive, and reminds the
caller of the idle deadline and native activity rule. The plan does not reserve a slot;
acquire rechecks availability and authority. `fleet simulator` is an alias
for `simulator`.

Owner HTTP routes are `GET /v1/operator/fleet-resources` and
`GET|POST /v1/operator/fleet-resources/simulators`. POST uses the same strict JSON
with `action: plan|acquire|touch|release`, a 16 KiB limit and fresh authority checks
before native effects. A disconnected acquire keeps its admitted lease.
Unavailable resource status is 503; rejected mutations are 409, or 503 while
the service restarts. These routes retain the existing operator owner boundary.

The manual `pnpm check:resources -- --run` proof starts an isolated Captain and
service embedding plus ten bounded command processes. Run its whole lifetime
through the active fleet limiter. It checks a two-slot pool, actual queueing,
process cleanup, service CPU and 250 ms health p95. Its fixed ten-by-two-second
workload must finish within 30 seconds, with the empty-pool first start within
five seconds; these are fixture regression budgets. It runs no coding model or
CoreSimulator; the VUH-1706 release gate remains the worker-bridge load proof.
The command is excluded from `pnpm check` and push, PR and scheduled CI.

<a id="views"></a>

### `view list` / `view create SPEC_JSON|--stdin [--ttl HOURS|Nd] [--pin]` / `view show ID [--text] [--watch]` / `view pin|unpin|expire ID`

A view is a private board that Clankie or the owner builds from live data
(VUH-2035). It is a **spec**, never page source: named data sources plus panels
that each show one source. The service reads the sources under the owner's
authority, and each surface renders the panels with its own components, so no
model-written script runs. Two sources ship today:

- `{"kind":"fleet_resources"}`: the snapshot `fleet resources` returns. Its
  panels show `capacity`, `queue` or `leases`, and can narrow to one
  `"resource": "heavy"|"simulator"`.
- `{"kind":"tracker_issues","repo":ID_OR_ROOT,"status":[...],"owner":O,"label":L,"limit":N}`:
  a `work list` filter through the repo's own tracker. Its panels show
  `issues`. The CLI resolves a `./` or `../` repo path against the current directory.
  A path is accepted only from this machine's own operator bearer, and it
  registers the repo. A paired device names a registered repo id; a create from
  a device with a path is refused with 400 (ADR 0191).

A spec has a `title`, 1–8 `sources`, 1–12 `panels` (`{source, show, title?, resource?}`)
and `refreshSeconds` (2–300, default 5). `create` validates the spec, keeps it,
and prints `{ view, render }`, where `render` is the first read. A view is
temporary for 24 hours unless `--ttl` gives 24h to 7d (`48`, `72h`, `3d`) or
`--pin` keeps it until expired. `unpin` makes a pinned view temporary again from
now. `expire` deletes it. Expired views drop out of `list` and `show`.

`show ID` prints the view with every source read now
(`{schemaVersion, view, renderedAtMs, sources}`). A source that cannot be read
returns `{"state":"unavailable","detail":...}` while the other sources still
render. `--text` prints the board as the console draws it, with control
characters in source text (issue titles, process names) replaced by spaces so
none reaches the terminal as an escape sequence. `--watch`
redraws it every `refreshSeconds` until interrupted. In the console, `/view ID`
opens the same board as a live panel, and `/view` lists your views. The
shipped [`views` skill](../.agents/skills/views/SKILL.md) teaches Clankie and his
workers when and how to make one.

Owner HTTP routes: `GET /v1/operator/views` lists views,
`GET /v1/operator/views/:id` renders one, and `POST /v1/operator/views` takes
`{action:"create", spec, ttlHours?, pin?}`, `{action:"pin"|"expire", id}` or
`{action:"unpin", id, ttlHours?}` (64 KiB limit; create answers 201). They use the
fleet-resources owner boundary: the operator bearer or a paired device with
terminal control. An unknown or expired id is 404, and the 50-view limit is 409.
A paired phone or desktop reaches the same routes through the relay and the public
gateway, which hold each request and answer to these schemas and answer a create
with 200.
Specs live in `~/.clankie/views/views.json`. Schemas are in
`packages/protocol/src/views.ts`. Hosted share links are not part of this repository.

### `fleet room [--older CURSOR] [--limit N] [--follow]`

The fleet room ([ADR 0273](adr/0273-the-fleet-room-is-a-durable-owner-only-coordination-record.md)):
one time-ordered feed of how the fleet coordinates. It holds lead briefs and
messages to workers, worker reports, peer and lead-to-lead messages, delivered
Auto rounds, owner questions with their answered or withdrawn state, and
`inbound` arrivals: a followed Linear activity or a Discord text message that
reached him (VUH-2403). The
host records each one as it happens, and only the owner reads it: this machine's
operator credential, or a paired device holding Take Control through the service
op `fleet_room`.

The JSON page is oldest first. Each entry has:

- `id` (the source's own id), `sequence` and `at`;
- `kind`;
- `from`/`to` (`{kind: lead|worker|clankie|owner|external, label, conversationId?, seatId?, personaId?}`;
  `external` is a person outside the fleet who is not the owner);
- bounded `text`, with credentials scrubbed (an `inbound` excerpt is at most 280 characters);
- `links` (the issue keys and commit SHAs the text names);
- `thread`, when one exists;
- `delivery.stage` as recorded (ADR 0211; `stored` is not read);
- `inbound` (only on `inbound` entries): `channel` (`linear`, `discord`, `github`),
  the `issue` key the source stated, and an https `url` that opens the source.

The page also carries:

- `older`, a cursor for the page before it, or null at the start;
- `newer`, a cursor to follow from;
- `recordingSince`.

`--older CURSOR` reads the page before a cursor, and `--limit` sets 1–100 entries
(default 50). `--follow` prints the page's entries and then each new one as a
JSON line until interrupted. It waits up to 20 seconds per read, so it adds
almost no load. Device op: `{op: "fleet_room", schemaVersion: 1, direction:
"older"|"newer", cursor?, limit?, waitMs?}`.

The room keeps the newest 2,000 entries, none older than 14 days. History from
before the host recorded the room is not reconstructed. An owner's answer text
stays in its conversation; the room says only that the question was answered.
Entries are display only and grant no authority. Nothing mirrors the room to a
channel or Discord.

<a id="fleet-status-fleet-set-notes-text-size-size-models-mode-fleet-clear"></a>

### `fleet [status|show]` / `fleet set [--notes TEXT] [--closure lead|owner] [--machine-setup lead|owner] [--commit lead|owner] [--push lead|owner] [--release lead|owner|time_rule --release-rule TEXT] [--gate-preset hands-off|balanced|careful] [--everyday-work allow|lead|owner] [--leaves-mac allow|lead|owner] [--hard-to-undo allow|lead|owner] [--money-and-accounts owner] [--tools connected|off] [--peer-messages on|off] [--remote-gates on|off] [--worker-sandbox on|off] [--lead-restarts on|off] [--seat-restarts on|off] [--auto-tidy off|30m|1h|4h|1d] [--harness NAME|auto] [--model NAME|auto] [--account LABEL|auto] [--hire-profile FILE.json]` / `fleet clear`

Read, set, or clear how the owner wants work routed across the agents Clankie
leads — which harness is the workhorse, which one reviews, what never goes to
which (up to 4,000 characters of free text), plus work closure, machine setup,
working preferences and the fleet connected-tool and peer-message switches. `set` takes any combination of the flags;
what is left out keeps its value. `clear` restores every default, including tools
`connected`. `--tools off` stops new standing tool admissions; manual grants keep
working. A call already past its last asynchronous check can still dispatch after
the change; there is no proven global concurrency or cancellation bound. That is the
chosen contract: the switch stops new calls
([ADR 0217](adr/0217-fleet-membership-gets-connected-tools.md), VUH-1585). `--tools connected`
restores standing access to verified accounts through `clankie_tools` and `clankie_call`.

`--peer-messages off` stops new messages between fleet workers independently of
connected tools. It hides `list_fleet_seats` and `message_peer` from current worker
catalogs and the service refuses sends from stale catalogs too. Existing receipts
remain readable for reconciliation; a message already handed to a native receiver
cannot be recalled. `--peer-messages on` restores the capability, which defaults
to on. Workers still need proven native pane/process and matching session identity;
a fleet bearer alone cannot send. See [worker peer messages](worker-access.md#messages-between-workers)
and [ADR 0213](adr/0213-clankie-retires-swarm.md#direct-peer-messages-vuh-1608).

Machine resources retain their local defaults. `clankie fleet resources` returns
the existing local snapshot; `clankie fleet resources --machine local` (or
`default`) returns a machine-identified status with measured CPU/RAM. A registered
machine ID selects that host alone. An unavailable host returns its saved policy
and an explicit unavailable status, never the local machine's capacity.

`clankie fleet set --machine ID --heavy-slots auto|N --simulator-slots auto|N`
saves limits for that machine. The same owner API backs the TUI resource editor
and shared app settings on phone, web and desktop. Without `--machine`, existing
local resource settings keep their behavior. Machine-specific local settings
take precedence over those defaults. Automatic counts resolve against the target
host's measured specs; simulator capacity is zero on hosts without macOS.
Machine settings are stored as `fleet.machineResources`; updates merge entries
and preserve policies belonging to other machines.

The status API is `GET /v1/operator/fleet-resources?machine=ID`; omitting the
selector preserves the existing snapshot shape. Machine policy updates use
`POST /v1/operator/fleet-settings`, its existing revision guard, and
`changes.machineResources`. `resourceMachines` in the settings snapshot lists the
supported IDs. A linked governor supplies its own specs, status and configuration
through the service's host adapter; native Windows provisioning is VUH-2091.
No shell or Herdr connection is opened by these resource API/UI paths.

`--seat-restarts on` (the default) enables fresh-session restarts for idle
hired seats at 450K context tokens in their own panes with the original brief,
work item and a fresh handoff brief. `--seat-restarts off`
leaves those sessions alone. This is independent of `--lead-restarts`, which
controls the default lead seat. Both settings are also available in `/fleet`.

`fleet status` reads `seatRestarts` from `GET /v1/fleet/seat-restarts`: each exact
native session's latest token check, refusal counts and handoff/restart receipt.
Before exit, the original native controller proves idle input, an empty styled
composer and the same process birth/shell/binding; the owner must have been quiet
for 15 minutes in both the pane and its leading conversation. A fresh private
registry/ancestry read refuses held or queued resources in all three lanes,
including native children and simulator reservations in every phase. Unrelated
work with proven different ancestry does not block it; unknown attribution does.
An orphan at PID 1 is unknown, and exact journal births are checked again after
the all-UID ancestry census.
The worker saves `.local/HANDOFF-<name>.md` and a confirmed comment on its existing
work item before the service keeps all recovery inputs and starts a fresh session
from the original launch. All launch admissions complete before exit, including
current maximum trust, signed-in account identity/key/canonical home, project/tools,
usage without a previous one-shot override (also for originally resumed hires),
and resource pressure. After signal,
only authority revocation or shutdown withholds the successor. A post-signal
failure immediately produces an uncertainty notice and preserves the original
receipt without replay. A good handoff reply whose recovery file or saved work
item cannot be verified likewise produces one immediate uncertainty notice and
never resends the request or attempts native exit. Ordinary refusals lasting two
hours produce one notice.
A definitely superseded kept handoff moves to `handoffHistory`; the next eligible
sweep requests one new nonce while retaining its old recovery inputs and receipt.
An uncertain original receipt is retained and never repeated automatically.

Only a surviving original local Claude/Codex shell launch can currently restart.
Prepared command panes and a service replacement that lost the original native
controller refuse visibly; remote restart control remains unavailable. These
are engineering limitations, not a request to type into or replace the pane.
Claude hires set `autoCompactWindow: 500000` and launch with
`CLAUDE_CODE_AUTO_COMPACT_WINDOW=500000` so saved model-specific windows cannot
override the backstop; default local Codex launches pass native
`model_auto_compact_token_limit=500000` and
`model_auto_compact_token_limit_scope="total"`. Codex's smaller native model
window can clamp that backstop. The installed Codex 0.163.0 binary exposes both
keys, and [its tagged native configuration](https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/config/src/config_toml.rs)
declares their token threshold and scope. Explicit controller-owned server
launchers retain their configured arguments; per-view remote launchers also keep
their own configuration because their native versions have not been verified.
These launch settings do not alter lead restart ownership.

`--lead-restarts on` (the default) lets the service restart the default lead
seat fresh in its own pane when it is idle, the owner has written nothing for 15
minutes, the pane holds no unsent draft, and its session has 250k tokens of
context or is 12 hours old (ADR 0293). Claude lead launches set
`autoCompactWindow` to 300k as a backstop. The seat first answers an escalation with a handoff
brief, which becomes the new session's first message; the old session stays
resumable and each restart leaves a notice in the conversation. Only a seat
started with `clankie <command>` from the pane's shell is restarted. `off`
leaves the seat's session alone ([ADR 0271](adr/0271-the-lead-seat-restarts-fresh-in-its-own-pane.md)).
`fleet status` reports `leadRestart` from `GET /v1/fleet/lead-restart`: the
budget, the latest check (context, session start, whether a restart is due) and,
while a due restart keeps being refused, its wait: when it began, the latest
reason (such as `busy`, `owner_active`, `draft` or `draft_unknown`) and a count
per reason. The wait survives service restarts. After two hours of refusals the
conversation gets one notice naming the reason; the wait ends when the seat
relaunches or is no longer due (VUH-2821). A source that cannot be proven records
`source_unproven`, including the inventory that did not answer; a missing,
ambiguous or unreadable transcript records `usage_unreadable` with its candidate
paths or read error. In those cases the optional legacy `check` is absent and
`unknownCheck` records the attempt's time and any partial usage. Existing v1
readers retain the refusal; the updated CLI says `budget unknown`. It gets the
same two-hour notice.

Claude Code accepts trust at the home directory for that session only. An
unattended relaunch into home therefore refuses `trust_required` before ending
the lead, even with a saved trust flag. The check uses the conversation's
resolved launch directory, which can override the pane's cwd. The notice names
the owner action: first accept folder trust for a non-home project using the
selected Claude account, then select it with `clankie workdir set PATH` and
restart captain. Trust the project before changing the workdir, so the next
unattended launch can use its persisted decision. An unprovable launch directory also refuses.

`--auto-tidy 1h` (the default; also `30m`, `4h`, `1d`) lets the service tidy
finished hires on its own (VUH-2392). Every five minutes it closes a local hire's
pane once the pane has sat idle or done for that long, its authenticated report
is kept, every report it sent has been acknowledged, no project names it as its
standing reviewer (`review.seat`), and no one kept it with
`keep_worker_pane` (`clankie agents keep`); a keep whose pane and session are
both gone from their fleet's listing is dropped by the same five-minute round,
and `unkeep` releases a gone pane's keep by its old pane id. The close runs `close_worker_pane`'s
guards: no unsent draft, still idle, and positive work proof. Automatic landing
requires ancestry in actual advertised `origin/main` or a retained merge-queue
handoff/current-HEAD work decision covering every unlanded commit; a pushed
feature branch, local ref or patch equivalence is insufficient. Missing or
non-Git working directories and incomplete observations hold the pane.
Hand-started and owner-interactive panes are never closed. A local project hire
whose start never confirmed is first adopted, as the operator's
`settle_hire_receipt` `adopt` does, only when its original receipt recorded the
exact native session and occupant now in the pane and its hiring conversation
is the one tidy closes it for; any other unconfirmed hire stays held. An
adoption that refuses holds the pane, and an unsettled original receipt fences
retirement even after its allocation is confirmed. The notice
names each adopted receipt. Hires idle past the window that it could not close
(unread reports, no kept report, unlanded work, an unconfirmed start, an unsent
draft) are listed in their lead's fleet round with the next step (VUH-2802). A keep excludes held
time; releasing it starts a full new idle period, even between sweeps, and a keep
arriving before native dispatch stops the automatic close. A refused close waits another
period before it is tried again. Each close is in `worker_pane_history` with the
usual five-minute Undo, settles its seat issue as a close does, and the hiring
lead's conversation gets one notice per sweep. Hourly, linked worktrees in
enrolled worktree roots whose HEAD is in `origin/main`, clean, with no live pane
or process inside and no checkout activity for a day are removed through the
`clankie checkouts prune` path (`.local` evidence kept, merged branch deleted),
at most 16 per repository per sweep. `off` stops both; the setting applies
without a restart.

Pruning preserves the exact HEAD of content-equivalent work under
`refs/clankie/pruned-worktrees/`, alongside decided-drop refs under
`refs/clankie/dropped-worktrees/`. Native HEAD/branch locks prevent a new commit
from losing its only ref during removal; changing or busy refs keep the tree.
A live non-Git parent directory also protects worktrees nested below it, except
`$HOME`, its ancestors and directories above the repository's main checkout.
Where the owner turned automatic tidy off, it stays off until they decide
otherwise; installing an update does not change that setting.

`--remote-gates on` lets an integrate batch gate on a linked machine while this
one is saturated; it defaults to off. Remote placement/staging times out after two minutes and falls back to the local gate with the reason recorded; cleanup is bounded to ten seconds. See [gates on a linked machine](integration.md#gates-on-a-linked-machine).

`--worker-sandbox on` starts each new local hire under an OS profile that denies
reading or writing the owner's protected credential stores: the protected
keychain, the file broker and the checkouts' `.env.local`
([worker access](worker-access.md#worker-sandbox)). It defaults to off and
applies only to hires started after the change. Codex hires are confined only
in maximum trust mode, because Codex's own sandbox can't nest inside it.

`--closure` and `--machine-setup` both default to `lead`:

| Setting        | `lead` (default)                                                                                                                         | `owner`                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `closure`      | The lead closes tracked work to Done after it has landed, relevant checks pass, and evidence is attached.                                | Park completed work In Review for the owner to close. |
| `machineSetup` | The lead and workers may install, refresh or prepare Clankie's own harness plugins, bridges and worker setup on already-linked machines. | Ask the owner before those setup actions.             |

Under lead closure, workers report to the lead without parking for owner
acceptance. Genuine owner-only gates (payments, evals or
sign-ups on owner accounts) get linked follow-ups without holding otherwise
delivered work open; missing implementation or verification is never a pass.

The owner may reopen work under either closure mode. Worker reports and native
delivery receipts alone do not establish acceptance or landing. Each project may
override each leaf independently with `project settings`, below. The CLI presents
the logical fields as `fleet.closure` and `fleet.machineSetup`; owner settings store
them under `autonomy.fleet`. These policies apply without a service restart.
Setup still requires an existing authorized route, preserves source-owned
configuration, and never restarts or steers existing lanes. Sign-ins, codes,
CAPTCHAs, payments, account or credential changes, and destructive actions outside
fleet workspaces remain owner decisions.

The same `autonomy.fleet` block holds working preferences. `--commit` and
`--push` use `lead` for without asking (default) or `owner` for ask first.
`--release owner` asks before official tags, packages or store submissions
(default); `lead` permits them after relevant checks, and `time_rule` requires
`--release-rule TEXT`. A rule is owner-authored guidance to verify against current
evidence, not a scheduler. Verification and reporting-style controls are retired;
the actual work and landing contracts define verification, and project owner-loop
cadence controls reports.
Explicit task and integrator gates take precedence, and these preferences
grant no additional account, tool or workspace authority.

Worker approval categories also live under `autonomy.fleet`. Each uses `allow`
("Just do it"), `lead` ("Clankie decides"), or `owner` ("Ask me"). Money and
accounts always stay `owner`. Choose `--gate-preset hands-off|balanced|careful`,
then optionally override `--everyday-work`, `--leaves-mac`, or `--hard-to-undo`.
A preset changes only these categories; existing `push` and `release` choices
remain independent. `fleet status` and `/fleet` show a summary generated from the
saved categories, including custom combinations. Labels and descriptions come
from `@clankie/protocol` so the TUI and app share their wording.

| Preset              | Everyday work   | Leaves your Mac | Hard to undo    | Money and accounts |
| ------------------- | --------------- | --------------- | --------------- | ------------------ |
| Hands-off (default) | Just do it      | Clankie decides | Clankie decides | Ask me             |
| Balanced            | Just do it      | Clankie decides | Ask me          | Ask me             |
| Careful             | Clankie decides | Ask me          | Ask me          | Ask me             |

Per-project settings accept the same category flags and `--gate-preset`, with
`inherit` to clear their overrides, through `clankie project settings PROJECT`.
The existing owner API accepts category leaves in the revision-fenced
`changes` object at `POST /v1/operator/fleet-settings` and
`changes.autonomy.fleet` in project updates. Current snapshots advertise
`fleetGates:true`; clients must not invent support on older hosts.

<a id="autonomy-dial"></a>

### `autonomy [status|off|low|high|full]`

One dial over all of the above: how much Clankie decides without asking
([ADR 0263](adr/0263-one-autonomy-dial-over-the-decision-leaves.md)). `off`
sends every gate, commit, push, release, close and machine-setup decision to the
owner. `low` uses the Careful gates, lead commits, and owner push, release and
closure. `high`, the
default, uses the Hands-off gates and lead closure, machine setup, commit and push,
with owner releases. `full` also lets workers act on outward work and the lead
release. Money and accounts always ask the owner. Verification and reporting
style are never changed by a level. The command prints JSON with `level`,
`description`, `revision` and every level's description. A level is computed
from the saved leaves, so any hand-set leaf reads `custom`. Whether he works
unprompted is a separate switch, [`auto`](#auto-switch): the dial never starts or
stops work.

The API is `changes.autonomyLevel` on `POST /v1/operator/fleet-settings`. The
level's leaves are written first, explicit leaves in the same change win, and
snapshots report `autonomyLevel` and, for `custom`, `autonomyDrift`: the nearest
preset and each differing leaf with its saved and preset values. Ties prefer
High, then Off, Low and Full. Any change that names `autonomyLevel` (the app's
first-run choice, Settings, `clankie autonomy LEVEL` or `/setup`) also records
`autonomyConfirmedAt`; a hand-set leaf never does. `changes.autonomyConfirmed:
true` records it alone, without changing a leaf: an app that saved the owner's
choice only on the device carries it over that way. Snapshots, `clankie fleet
status` and `clankie autonomy` (`confirmedAt`) report it, and the apps ask for a level only while it is absent
(VUH-2725). Doctor, the console footer and the lead's fleet
card show this passive indicator; reads never change saved authority. A snapshot without it comes from an older
service, so the CLI refuses to set a level there. In the console, `/autonomy
LEVEL` sets the dial and `/autonomy clear` cancels the selected chat's scheduled
wake.

First-run `/setup` explicitly asks for Off, Low, High or Full using the same
descriptions and API. The choice is confirmed before model setup can become
ready; cancelling leaves the saved leaves untouched and does not advance setup.
A ready console's `/setup` also asks before pairing or hiring. The hosted
console's `/setup` opens this choice before its settings menu.

<a id="auto-switch"></a>

### `auto [status|on|off]`

The master switch for unprompted work
([ADR 0264](adr/0264-projects-on-auto-replace-goals.md)). While it is on, Clankie
works every project on Auto (`project settings PROJECT --auto on`) and fires the
wakes he schedules. Off stops both at once; nothing already running is
cancelled. It is the global autonomy runner switch in
`~/.clankie/captain/autonomy.json`, which reads as off when it cannot be read.
Turning it on needs the owner operator credential, or a paired Take Control
device, whose own identity the relay carries to the service; reading it or
turning it off needs neither, so a chat-only device can still stop unprompted
work. Prints `{"auto":"on"|"off"}`. The console's `/auto on|off` is the same
switch.

Each fleet-round interval (30 minutes by default) the service checks the
projects on Auto. The next check deadline survives service restarts; an overdue
startup checks promptly once, without replaying every missed interval. Accepted
and pending delivery fingerprints survive too, preserving the two-hour idle
rewake window. This state lives in `~/.clankie/captain/auto-rounds/cadence.json`;
the ordinary round record below shows actual wake attempts.
An explicit bound tracker project matching a configured lead's
project route wins, even when that lead's chat uses another workspace. A lead
with configured project ownership never receives another project through a
workspace match. Only an unassigned lead may match by exact workspace and
machine; absent or ambiguous ownership goes to the global head. These are the
existing `linear routes` destinations, with no new Auto routing setting.
Each lead hears only its projects' names, focus, bound tracker project and live
workers in local workspaces and worktree roots. Each lead wakes independently
when its evidence changes, or after two hours when it has not. Before admission
the service rechecks the master switch, project Auto settings and routing.
The wake grants no tool or authority beyond an ordinary turn, and a native
harness seat receives it like any other wake.

A service-lane autonomous turn may execute `hire_agent` when the master switch
is on, the owner's saved global autonomy is Full and the resolved project is on
Auto. Its project preferences must allow everyday and outward work and
lead-owned machine setup. Otherwise it can propose a hire and receives a clear
refusal. The ordinary project/role caps, machine governor, account holds,
checkout and native delivery checks still apply. Switching Auto off or lowering
permission during preparation prevents the pending native effect.

New hired Claude workers launch in `auto` mode, preserving managed and tracker
denies and the permission hook, with no blanket `ask` rules or Bash allow.
[Maximum trust mode](#maximum-trust-mode) replaces that mode at launch while it
is on.

### `auto rounds [--project ID] [--limit N]`

Reads the Auto round record ([ADR 0270](adr/0270-auto-rounds-measure-outcomes-and-name-drift.md))
through `GET /v1/auto/rounds` with the operator credential, newest round first
(20 by default, at most 200). Each round lists, per project it carried, what the
service measured before waking the lead, and whether that wake was delivered
(`delivery` is null when it never settled, for example across a restart):

- `staffing` on each project: explicit ready issue keys, backlog keys and blocker edges;
  working, idle/done and occupied seats; worker and Started-issue WIP caps; and
  fresh per-plan remaining usage, reset horizon and burn/spare capacity per day.
  `under_staffed` means ready work, positive plan headroom and room under the caps
  coexist. `backlog_not_ready` asks the lead to plan ready slices rather than idle.
  The next recorded round checks increased active staffing or records `cap_reached`,
  `no_ready_work`, `plan_reserve`, `unresolved` or `unknown`.
- Round-level `staffing`: ready-work, seat and Started-issue totals, summed worker/WIP caps
  (null when any contributing project leaves that cap unset), and the plan snapshots.
  Unknown sources stay unknown/null; unset caps are null. Plan headroom requires
  fresh usage within five minutes, sign-in, no owner hold, more than 10% remaining
  in every general window, and positive spare capacity at the observed pace.
  Staffing is advisory: ordinary project, machine, model and hire admission still apply.
  The CLI requests `includeStaffing=true`; HTTP clients must opt in so older strict
  clients retain their response shape. Historical rounds may omit staffing.

- `window`: since the last milestone (a closed parent issue or a complete tracker
  milestone), or the 14-day lookback start when none is known.
- `closures`: keys closed in the window, split `ownerFacing`, `tooling` (every
  default-branch commit naming the key touched no product path), `unlinked` (no
  commit names it; counted as owner-facing) and `unclassified` (churn unreadable).
- `started`: started-state issues now, by state, with the configured project `wipCap` (null when unset).
- `churn`: lines added plus deleted by bucket (product, tooling, docs, excluded) on
  the origin default branch, local or mirrored for remote-only projects.
- `days`: per local day for the window and the last seven days, whether it was a
  working day (a landing or an issue state change), its churn, closures and state changes.

- `drift`: the signals the round named (VUH-2284): `tooling_lead` (tooling plus docs
  churn above product on the last two completed working days), `nothing_closed`
  (the last completed working day closed nothing owner-facing) and `over_wip` (more
  started issues than the WIP cap, once one exists), each with its day and numbers.
  `carried: true` marks a detection from an earlier round whose wake was not
  delivered; a detection clears only once a round carrying it is delivered.

- `correction`: the lead's chosen issue, one-line reason and response time, joined
  to the original drift round. The shared `record_drift_correction` lead tool
  takes `projectId`, `roundId`, `issue` and `reason`; service turns, native seats
  and remote project leads use the same conversation-scoped implementation. It
  records a decision without changing tracker state or staffing. An exact retry
  returns the retained choice; a changed choice requires a later drift round.
- `correctionCheck`: the next round's independent check of that choice.
  `issueStarted` reads the tracker started state/history; `productLines` counts
  project product churn landed after the response, independent of milestone
  window changes. `state` is `satisfied`, `unresolved` or `unknown`; reasons
  distinguish missing progress from unreadable sources. Unresolved choices remain
  in subsequent normal rounds until satisfied. Product churn is project-wide,
  not attribution to the issue.

- `report`: newly seen `milestones` requesting one combined project status update,
  optional evidenced `progress`, and the later `updates` linked back to that request. Each update carries its id,
  URL, creation time and `unexpected`: true for routine posts or extra posts after
  a request was already fulfilled. Updates are reconciled every measured tick,
  even when no wake is due; association is by tracker identity and time, not proof
  of authorship or of the update body's media and evidence.

A closed parent or a nonempty tracker milestone with all counted issues completed
asks the lead for exactly one update with media and evidence links. With project
`autoUpdates` on (the default), accumulated evidenced progress also qualifies:
captioned media on two distinct completed/started issues, or a completed issue
linked to landed product code. The service reuses its tracker/origin reads and
samples descriptions plus the three latest comments per issue; it does not scan
full comment threads or download assets each round. The lead reviews the evidence
when due and leads with clips/stills at stable asset URLs and short captions, then
open work and next steps. Progress requests are spaced at least 24 hours after the
latest observed update or claimed request; new milestones can report sooner.
`autoUpdates:false` keeps the existing owner-loop cadence. Silent always suppresses
posts, and explicit landing cadence still reports new landings. Routine rounds
without a due request ask for none. Claims use stable tracker ids, survive renames and service
restarts, and are recorded before dispatch. A definite delivery refusal can retry;
an uncertain delivery stays claimed and unsettled to prevent duplicate requests.
Historical velocity-only rounds claim no posts. The owner-loop default is milestones;
project `ownerLoop` can suppress requests (`silent`) or include newly observed
landings (`landings`). First landing observation establishes a baseline.

A part the service could not read is `{"state":"unknown","reason":…}`, never zero.
The wake carries the same numbers as one line per project. The record lives in
`~/.clankie/captain/auto-rounds/` (`rounds.jsonl`, append-only, and
`projects/<id>.json` with the last milestone); this command makes no tracker or
git calls.

Historical replay uses the same service measurement and slice-1 drift detection:

```sh
clankie auto rounds --replay --project kh2-multiplayer --since 2026-10-10T00:00:00-05:00 --until 2026-10-14T00:00:00-05:00
```

The operator GET route accepts `replay=true`, `project`, `since` and `until`.
The increasing range is bounded at 14 days and cannot extend into the future;
it selects complete local calendar days in the service's time zone. One replay
round per day measures at the following midnight, so the selected day is complete
for drift detection. Records have `replay:PROJECT:DATE` IDs, conversation `replay`
and null delivery. Replay reads tracker state spans and the already-fetched origin
or mirror; it sends no wake, writes no tracker or round record, and consumes no
pending detection. Project, parent and milestone membership use today's bindings;
Auto history is unavailable. Historical state and completion are reconstructed
from the spans, including issues that closed or reopened after the selected day.
A two-minute measurement budget bounds the replay. Unreadable measurements stay
unknown with reasons; an exhausted overall budget refuses the request.

`tooling_lead` and `nothing_closed` use the ordinary completed-day rules. Replay
applies today's configured `wipCap` to historical Started counts and can emit
`over_wip`; it does not substitute a worker cap or invent historical policy.
An unset cap remains null and is named in the replay caveats. Replay requires an updated
service; older services refuse the query.

<a id="maximum-trust-mode"></a>

### `maximum-trust-mode [status|on|off]`

The owner's one switch over the guardrails of every harness Clankie launches
(VUH-2048). Off, the default, keeps each harness's own auto mode: `clankie claude`
and Claude hires start with `--permission-mode auto`, whose classifier stops
risky commands. On, the next launches start without their permission and
command guardrails, through each harness's native flag:

| Harness         | Flag while on                                                                                                      | Applied at launch                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Claude          | `--dangerously-skip-permissions`                                                                                   | `clankie claude`, Claude hires, remote project leads |
| Codex           | `--dangerously-bypass-approvals-and-sandbox`, as `-c approval_policy="never" -c sandbox_mode="danger-full-access"` | `clankie codex`, Codex hires (local and remote)      |
| Grok            | `--permission-mode bypassPermissions`                                                                              | `clankie grok`, Grok hires                           |
| OpenCode        | none: its permissions come only from config                                                                        | —                                                    |
| Pi, Prime Agent | none: they ask no approvals                                                                                        | —                                                    |

Codex seats and hires run a dedicated app-server whose server and view share
`-c` overrides, so the flag is applied as the two settings it sets; on hires it
replaces the `on-request` approval policy fleet gates otherwise select.

What it bypasses: every permission prompt and Claude's auto-mode classifier.
The agent runs any command, edits any file and reaches the network without
asking, with the accounts and credentials its machine holds. Claude still
enforces deny rules in every mode, so managed denies and the tracker denies
Clankie adds stay, and a managed `disableBypassPermissionsMode: "disable"`
refuses the mode outright. Native prompts that still appear remain the owner's.

It applies to launches after the change. Running seats keep the mode they
started with until relaunched: the snapshot's `seatsOnOtherMode` lists this
machine's live seats (`seatId`, `title`, `harness`, `maximumTrust`) whose own
process flags still show the other mode, read through Herdr. Remote machines
are not listed; a remote lead's launch receipt records its `maximumTrust`. It is not the autonomy dial: [`autonomy`](#autonomy-dial)
and [`auto`](#auto-switch) decide what Clankie does without asking, this only
what a launched harness may run without asking, and neither implies the other.

Owner-only: `GET` and `POST /v1/operator/maximum-trust-mode`
(`{"schemaVersion":1,"enabled":true}`), authorized like the other owner
settings (the operator credential, or a paired device with Take Control). No
worker, peer, room or tool can set it. The command prints
`{"ok":true,"enabled":…,"description":…}`, plus `warning` while on and
`seatsOnOtherMode` when the service could observe its seats. In the console,
`/maximum-trust-mode` opens the switch, and `/maximum-trust-mode on|off|status`
sets or reads it; the hosted console lists it under `/settings`.
Settings presents Maximum trust as the top autonomy choice. The existing CLI switch
and its stored value remain available. API clients can request
`GET /v1/operator/fleet-settings?includeMaximumTrust=true`; the returned revision
covers both fleet policy and `maximumTrustMode`. A POST to the same opt-in URL
can save `autonomyLevel: "full"` and `maximumTrustMode: true` atomically, or disable
trust while choosing another level. Omitting the opt-in keeps the legacy snapshot
and revision shape. A maximum-trust write requires the opt-in revision.

The hire-defaults GET accepts `includeModels=true` to return `agents` with their
registry model IDs and display names. This read changes no saved default. Legacy
reads and writes retain their existing wire shapes.

`clankie claude|codex|grok --dry-run` shows the resulting flags and `maximumTrustMode`.
When the service cannot report the mode, the seat launches in auto mode and
says so.
For a pending permission, `message_seat` accepts `questionAnswer` with its exact
request and question IDs through the worker's existing private authenticated
lead lane. Scoped ordinary file calls and literal `pwd`/`git status` can follow
the effective routine-work gate; web tools follow the leaves-Mac gate.
Ambiguous shell/MCP calls, protected or outside files, recursive searches and
unverified remote workspaces remain owner-only. Peers, rooms and Discord
cannot answer permissions. Owner decisions use the authenticated question inbox.
The opted-in Claude channel also declares its native permission relay. Its
sanitized preview cannot establish routine authority, so those requests stay
owner-only. Each decision records its authenticated lead conversation, owner
principal or system-denial reason in the captain's
`claude-worker-question-claims.json.decisions.json`, with input hashes and separate
`decided`, `hook-written` or `channel-written` delivery stages. A channel write
has no native application receipt and stays unconfirmed; never retry it.

New local Codex hires retain their sandbox and use
`approval_policy="on-request"`; a trusted native containment policy keeps final
precedence. Their `clankie` worker bridge alone is configured with
`default_tools_approval_mode="approve"`, because the service already decides
each bridged call; every other MCP server keeps Codex's native approval. These mappings do not change a running lane, bypass managed policy,
or prove that a harness can enforce every semantic category. Remote launches
retain their existing native permissions. Owner-managed native custom allow,
ask and deny rules remain with the harness; Clankie does not persist a separate
custom-rule evaluator.

`fleet status`, `doctor --json` and the TUI `/doctor` expose the resolved preferences for the actual
current workspace through the verified service context, including the project
ID or global inheritance. Agents launched independently can read this same
context. Unavailable, ambiguous or unverified context is reported explicitly.
Global fields remain visible separately, so project overrides are apparent.
Every hire receives resolved preferences in its native brief, even when no task
brief is supplied; machine-bearing "Your fleet" prompts refresh them each turn.
Ask Clankie to view or change a preference and he uses these same CLI/API tools.

Legacy settings migration seeds the weekly release rule only on an existing
owner project with ID `clankie` that has no release override: the last `v*` tag
must be more than one week old and `main` must have user-visible changes worth
shipping. It creates no project, workspace or grant. Persisted global working
preferences mark the migration complete; clearing that project override then
stays cleared after restart. An unregistered project inherits global ask-first
releases. See [ADR 0230](adr/0230-fleet-responsibility-is-owner-settings.md).

`--harness`, `--model` and `--account` update default workers one field at a time
(`fleet.hire`), preserving native subagents, delegation and placement.
`auto` removes a field so Clankie chooses it per job. `--mcp-servers NAME,...`
names the owner's own MCP servers every local hire may start; `none` clears it.
A local Claude or Codex hire otherwise starts only Clankie's worker bridge and
the servers its checkout declares. Role and per-hire `mcpServers` add to this
list ([agent hosts](../packages/agent-hosts/README.md#worker-mcp-servers)). `--hire-profile FILE.json`
replaces the whole profile; use it separately from the field flags. Explicit
per-hire choices override project roles, which override fleet defaults. These
settings affect new hires. `fleet clear` also removes worker defaults.
The TUI status prints `worker defaults: …`, or explains that Clankie chooses
when no fields are set.

Fleet size, model mode, verification mode, reporting style and fleet-wide hire
effort are retired controls. Exact previously saved values are retained in the
read-only `retiredWorkingPreferences` migration receipt. Their legacy response
fields remain for compatibility, but edits are rejected. Use numeric worker caps,
project hiring constraints, per-job effort and owner-loop cadence instead.

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
can. The section carries effective autonomy policy on machine-authorized lanes,
including the default `lead` responsibilities.

JSON includes the global `fleet` projection and a separate workspace
`workingPreferences` report, with either available resolved values or an
unavailable detail. `fleet status` also reports `deployHolds`: each current
[deploy hold](integration.md#deploy-holds) with a `summary` of its holder, how
long it has held and the time left, or an `unavailable` detail when the service
cannot list them. The TUI `/fleet` command opens the same editor (worker
harness, model and account, connected tools, peer messages, closure, machine setup,
working preferences and notes), with retired saved values shown read-only
and `/fleet status` (also `/fleet show`) prints the same values. CLI `fleet show` aliases `fleet status`.

```bash
clankie fleet set --notes "codex is the workhorse. claude when it needs skills or long context. grok for a hostile read on work that already passed review. never codex on Swift."
clankie fleet set --peer-messages off
clankie fleet set --harness codex --model gpt-6.1-sol
clankie fleet set --model auto
clankie fleet set --account auto
clankie fleet set --closure owner --machine-setup owner
clankie fleet set --commit lead --push lead --release owner
```

<a id="runtime-setup"></a>

### `transfer`

```bash
clankie transfer --to hosted [--transfer-id UUID] [--replace]
clankie transfer --from hosted --to local --destination-machine JOIN_ID
clankie transfer --to URL --to-token-file FILE [--transfer-id UUID] [--replace]
clankie transfer --from URL --from-token-file FILE --to local --destination-machine JOIN_ID
clankie transfer status [--at hosted | --at URL --token-file FILE]
clankie transfer rebind --transfer-id UUID --machine JOIN_ID [--at URL --token-file FILE]
clankie transfer abort --transfer-id UUID --to URL --to-token-file FILE
clankie transfer reclaim --force --reason TEXT
```

Moves Clankie to another body and back. One body holds him at a time
([ADR 0286](adr/0286-one-body-holds-clankie-at-a-time.md)). `local` (the default
`--from`) is this machine's service with its operator credential. `hosted` is
the managed body this terminal is signed in to (`clankie connect hosted`). It is
reached as the paired hosted device through the gateway's encrypted envelope, so
no token leaves the Mac. Any other body is a URL plus a file holding that body's
operator bearer; tokens are never command arguments. Through the gateway, a
paired device needs Take Control. Supervise is refused.

Bundles move in chunks that fit the envelope: 384 KiB per upload request and
4 MiB per download response. The destination verifies the whole bundle's size
and SHA-256 before staging, and a resent chunk rewrites from its offset.

The command freezes the source and waits for it to restart dormant. It then
downloads the bundle, stages it on the destination, applies it and waits for the
destination to restart as Clankie. Only then is the source released.

- **Freeze** waits for no running turn, voice stay or activity share. Worker
  panes keep running.
- **Restarts** need a supervisor (autostart's recover pass or the hosted
  launcher). Without one, the command says which body to `clankie start`.

Each step is repeatable: rerun with the printed `--transfer-id` after any failure.
The source stays frozen until the destination reports itself active with the same
self id, epoch and transfer id.

The destination admits a bundle only in three cases:

- it is unclaimed, with no memory or model conversation of its own;
- it holds the same Clankie, released at a lower epoch;
- `--replace` is given, which archives its own history under
  `transfer/archive/<id>/` and never merges.

**What moves:**

- the self record, persona and appearance, Discord ownership and room settings,
  fleet, autonomy and trust settings;
- memory, conversations and room turns with their receipts, attachments,
  routines and Auto history;
- project settings, the built-in tracker, registered repos, Linear bindings and
  receipts, views and evidence.

**What stays:** the credential broker, model and harness sign-ins, account
tokens, paired devices and the event log, gateway identity, machines and joins,
Herdr bindings and live hire records. The manifest lists every state entry that
stayed.

Workspaces on the source's `local` machine arrive as `transferred:<id>`. After the
old machine [joins](#join) the destination, `rebind` points them at its join id.
On the way back, `--destination-machine` names that join id so those workspaces
become `local` again.

A frozen or released body serves only `/health` and these routes. `/health`
carries `self` (`selfId`, `epoch`, `state`, `releasedTo`), so `clankie status` on
the old machine shows where Clankie went. Every other route answers
`503 body_dormant`.

- **`abort`** returns the source to active only after the destination burns the
  transfer id.
- **`reclaim --force`** reactivates a dormant body at a higher epoch without the
  other body. It records the reason, and any work the other body did is not
  merged.

A dormant body keeps its doorway ([VUH-2583](https://linear.app/vuhlp/issue/VUH-2583)).
It runs the same app composition as an active body, with no captain and a gate
that admits only:

- `/health`;
- the transfer routes;
- the hosted-operator envelope, whose inner request is gated again;
- device session refresh.

Its gateway connection, hosted security and device authority are the active
body's. So a frozen managed body can export its bundle and be released by the
owner's Take Control device, and `--from hosted` brings Clankie back. A frozen
body builds its bundle at boot, before anything else opens. `dormant` in status
means the process booted dormant: a body that froze itself and is still shutting
down reports `frozen` but not dormant, so nothing exports from it. The real-model
proof between two private bodies is `apps/clankie/scripts/prove-body-transfer.ts`
([evidence](testing/2026-10-21-vuh-2577-body-transfer/README.md)). The hosted CLI
and gateway proofs are in
[VUH-2582 evidence](testing/2026-10-21-vuh-2582-transfer-gateway/README.md) and
[VUH-2583 evidence](testing/2026-10-21-vuh-2583-dormant-doorway/README.md).

### `join`

An outbound machine connection needs no SSH alias or inbound port. On the
joining Mac or Windows PC, run:

```bash
clankie join --gateway https://YOUR_GATEWAY --host HOST_ID --directory /approved/workspace
```

The command generates a 256-bit approval CODE locally, prints it and waits
up to five minutes. Keep CODE out of logs and evidence. From an existing owner device
or the service's authenticated CLI, approve that code:

```bash
clankie join approve CODE --access workers --directory /approved/workspace
```

Approval selects only directories advertised by the joining host. The receiver
pins that original level and directory consent. Access may be lowered or
restored within that ceiling; raising it beyond consent requires leaving and
joining with a new owner approval. Keep `join`
running in its terminal. `join status` reports the locally stored registration;
`join resume` restores its outbound channel. `join leave` revokes registration
and removes its broker credential. `machines remove join-UUID` also revokes it;
the old capability cannot reconnect, including after service restart. A new
join needs a new code, owner approval and machine identity. Interrupting the
foreground command disconnects it without revoking approval. A running `join`
rides out a home restart or network loss: it says on stderr that Clankie is
unreachable, retries with backoff up to 30 seconds and says when it reconnects.
Its `--json` stdout events are unchanged. A request whose delivery was lost
fails at the home and is never replayed. Leave, removal, or a home that sends
another machine's identity or a duplicate request ends the command. Every other
failure, including a home that is gone for good, keeps it retrying after one
notice. A joined seat refused by the machine's level names the machine, its
level and the level required, inside the encrypted response.

At `shell` or `screen`, Clankie can run his own shell on a joined machine with
the `joined_machine_shell` tool. It is offered only in the owner console lane,
never in Discord (even owner-only rooms) or to peer seats. Only turns the owner
started may use it. Autonomy, Linear wakes and worker reports are refused, but
input steered into an owner's running turn inherits that turn's owner status.
Every call rechecks the machine's live level. The command runs as that machine's owner with `/bin/sh` or
PowerShell. It starts in a folder approved at join, but the shell itself is not
confined there (OS confinement is VUH-1804).

It gets 30 seconds and up to 8192 characters of output. The first line is the
joined machine's own `[exit N]` or `[stopped …]`, and stderr is marked. The command
runs in its own process group (a process tree on Windows). A time limit,
revocation or a level below `shell` stops everything it started, and anything
still running when it ends is stopped too. A process that deliberately leaves the
group (`setsid`, a daemon) is not, and on Windows children still running after
the shell exits are not stopped. At `screen`, a shell can also reach the screen
through the machine's own permissions without the screen-lending consent; screen
lending without shell is not available, so an owner who wants neither chooses
`workers`.

Each call is recorded on the home before anything is sent; `machines shell-audit`
lists the records.

From an approved folder on a joined install, `clankie claude [--new | --conversation ID | --resume … | --reset]`
opens the local Claude Code seat in a workspace chat stored at Clankie's home.
Plain `clankie claude` reuses an existing chat for that machine and folder, or
creates one; `--new` creates a separate chat. An exact `--conversation` must
belong to this joined machine and folder. `--dry-run` creates no chat and opens
no seat. The bundled seat plugin supplies Clankie's identity, channel and
transcript hooks. The home supplies maximum trust and the delegated project
lead tools, including its connected tracker; home configuration, accounts and
unrelated chats remain outside that delegation. Traffic uses the authenticated,
encrypted join channel, with no SSH or local Clankie service. A second launch
in an occupied chat is refused. Closing the launcher revokes its seat grant;
an unconfirmed close expires after one hour without traffic. A home restart
invalidates these grants; reopen the seat rather than replaying a tool call.
`--resume` keeps the recorded Claude session and home chat; an explicit session
uses the same local transcript checks as a home launch and must run from its
original approved folder. Retired or cross-chat sessions are refused. `--reset`
archives the current context and retires native sessions while retaining the
folder chat. It revokes earlier lead and worker grants, reports earlier launch
session IDs, and leaves their panes for the owner to inspect. It cannot combine
with `--new` or `--resume`. Reset uses the chat's revision guard and refuses an
active turn or side conversation. Earlier-launch reports are bounded to the last
32 IDs held by this home process; a home restart loses that list.

The joined lead's `hire_agent` starts Claude workers in new Herdr panes on the
same approved folder, using the bounded workers adapter in the running `join`
channel. Supply `title`, `brief`, optional `model`/`effort`; `harness` can only be
`claude`, and an optional `workingDirectory` must equal the lead's folder. The
brief is staged in a private file under that machine's Clankie state and named by
Claude's one-line startup prompt. The adapter admits the exact native session
Claude reports, without waiting for its first turn to finish, so a report from
inside that turn is accepted. The worker gets
only `message_clankie` (text, a caller-chosen UUID `deliveryId` and optional `urgent`) and
`message_clankie_status` (`deliveryId`). Reports are durable in its lead chat;
the lead reads and acknowledges them through `worker_reports` and
`acknowledge_worker_reports`. `message_seat` with the returned `seat` and
`message` reaches that worker's native channel. There is no SSH fleet link,
owner bearer, connected-account grant or general shell in this transport.
Uncertain launches and reports must be reconciled, never repeated. Grant expiry,
reset, access downgrade, leave and home restart refuse later traffic; existing
native panes remain open. Keep `join` / `join resume` running for worker launches.

Clankie himself hires there too: at `workers` or above, his own `hire_agent` with
`fleet: "join-UUID"` and a `workingDirectory` inside a folder approved at join
starts a Claude worker through the same adapter, or a Codex worker with
`harness: "codex"`, each signed in with that machine's own account. Only turns the
owner started in the owner console may hire there; a folder outside those approved
at join is refused as `unknown_directory`, another harness as `harness_unavailable`,
and a lower level names the level required. The worker reports into the chat that
hired it, and `message_seat` to the returned `join-UUID/PANE` seat reaches a Claude
worker; a Codex worker there takes no messages yet.

Other harness seats, Windows release packaging, legacy SSH chat migration and
real native PC/production-gateway proof remain follow-ups. Plain `clankie`
on a joined install explains how to open a seat; `start`, `restart` and `recover`
point to the home instead of starting another Clankie.

Inventory reports `transport: join` and `accessEnforcement: joined-host` for
these approved identities. The receiver checks the current access level and
intersects the service-approved directories with its own canonical directories
before execution; a symlink escape is refused. The channel supports a guarded
shell at shell/screen level and a bounded native Claude worker adapter at workers level;
screen level can host a consent-bound computer through the same encrypted channel.
workers-level shell and screen requests are refused. Directory checks bind the
requested working directory; an authorized shell command still runs as the
owner and can address other paths. The explicit local macOS envelope described
below does not confine these joined receivers.

The public service and client contract is implemented. Production gateway
bootstrap/channel routing and admission/rate limits belong to `clankie-ops` and
has separate source and rollout evidence; real Mac/Windows driving remains an
owner-run live gap.
Do not treat a loopback relay fixture as a live gateway deployment. The gateway
cannot read or forge joined-host capabilities, commands or results
([ADR 0173](adr/0173-the-gateway-cannot-read-device-traffic.md)). Bootstrap sends
only the approval hash. Owner approval carries CODE through the existing
authenticated/encrypted device surface, and the lease is encrypted for its
original holder. Channel and leave use authenticated AES-256-GCM envelopes
with fresh one-use challenges and independently keyed responses. TLS still
protects the carrier; an untrusted gateway can deny delivery but cannot forge
work. Broker keys stay at both endpoints; the registration ledger stores only
token hashes. Worker/shell outputs are bounded to 8,192 characters and report
truncation. Structured screen results use a separate 65,536-character bound and
never truncate; PNGs travel in 49,152-character chunks within the existing
envelope/body caps. Oversized or stale screen data refuses.

### `machines [list|discover] [--json]`

A machine is where agents run; a device is a paired phone or desktop portal.
`machines` prints one row per machine: access level, Herdr sessions, state and worker count
(`?` when unavailable). `--json` returns `{ observedAt, machines }` from
`GET /v1/machines`. Discovery reads local Herdr sessions and literal aliases in
the owner's SSH config (including bounded `Include` expansion). Probes use BatchMode and strict known-host checking,
never prompt, start a server or install remote software. Four probes run at
most concurrently, with a three-second probe deadline and a 6.5-second listing
budget. Unreachable and still-discovering candidates remain visible. Results
are cached for fifteen seconds; `discover` refreshes them.

```bash
clankie machines add pc --ssh my-pc --shell powershell
clankie machines access pc workers
clankie machines sessions pc
clankie machines sessions pc --connect work --id pc-work
clankie machines remove pc
```

Owners choose cumulative `portal`, `workers`, `shell` or `screen` with
`clankie machines access NAME LEVEL`, or Settings → Machines / `/machines`.
Existing local installs retain screen; new or ungranted remote machines start
at portal. `PATCH /v1/machines/:id/access` takes `{ "accessLevel": "workers" }`
and requires the operator bearer. Inventory includes `accessLevel` and
`accessEnforcement`; older servers display `unreported` rather than an inferred
grant. Local/SSH enforcement is `service-preference`; approved joined receivers report
`joined-host`. These are authority checks. An explicitly prepared macOS launch
reports `os-sandbox`, `accessCeiling` and `approvedDirectories` after verifying a
kernel-refused outside read. Actor,
room and workspace grants remain independent; bounded service-owned I/O is
not general shell permission. Policy is checked on each native tool call,
after worker waits and before screen effects. Revocation leaves recovery
available and does not terminate existing workers. The public joined receiver checks are covered by VUH-1800; live gateway captures
and native worker/screen adapters remain gaps.

### A lower local Mac with an OS boundary

An owner of an installed macOS release can prepare a Seatbelt envelope:

```sh
clankie machines sandbox prepare shell --workspace /absolute/project --home /absolute/private-home
clankie machines sandbox status
```

Repeat `--workspace DIR` for each approved directory. Levels are `portal`,
`workers` or `shell`; screen requires the ordinary unrestricted launch. This
command prepares controls and a private copy of non-secret settings. It does
not stop, restart or confine an existing process. From an owner terminal,
provision the private home's necessary credentials and service state, deal with any unrestricted
existing workers, then use `clankie stop captain` and `clankie start captain`.
The private home starts with separate stores; preparation does not copy existing
conversations, memory, paired-device records or harness authentication. Original
stores remain intact and the ordinary full launch uses them again. The owner
must plan a stopped-state handoff before using this as the continuing runtime.
Check `clankie machines --json`: `os-sandbox` describes the running service;
`sandbox status` only describes its next-launch controls.

The kernel permits file contents in approved workspaces, the private home,
read-only installed runtime and exact native loader dependencies, and OS support paths (`/System`, `/usr`, `/bin`,
`/sbin`, `/Library/Apple`, `/private/etc`). File metadata remains visible.
Private temporary files live inside the new home. The service and its fresh
private bundled Herdr/worker descendants share this boundary; local named fleets refuse and external or
already-running fleets are not adopted. Each bounded service restart starts a
fresh fleet; surviving workers from the previous bounded daemon are not
reattached or terminated. Finish or manage that fleet before restarting.
The owner Keychain, login profiles,
outside Unix sockets and other file contents are excluded. Credentials and
required writable resource directories must be explicitly provisioned/granted;
unavailable broker, harness or fleet resources refuse rather than escape. Install
needed harness executables in the private home's `bin`; the bounded PATH excludes
ambient owner installations. Read-only runtime files cannot have writable hard-link
aliases. macOS's narrow dyld bootstrap profile supports the native loader; broad
system XPC rules are not imported.
Internet TCP and loopback service HTTP remain permitted. This is not a network
exfiltration barrier, a VM, or isolation from independently authorized remote
services. Apple's `sandbox-exec` is deprecated; unsupported launches fail closed.

To restore full access, run these from the owner terminal outside the sandbox:

```sh
clankie stop captain
clankie machines sandbox remove
clankie start captain
```

Removal keeps the private home and workspace data and needs no reinstall.
Existing bounded processes remain bounded; API/settings changes cannot lift
their kernel restriction. A changed installed runtime needs owner removal and
re-preparation; recovery never substitutes an unrestricted launch. Source
checkouts are not supported by this installed-runtime envelope. Live owner
lower/hire/outside-read and restore proof is held in VUH-1804; disposable native
process integration evidence is recorded in
[ADR 0257](adr/0257-a-lowered-local-runtime-keeps-an-os-boundary.md).

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
`connect_runtime` (`id`, `session`, optional `machine`, default `local`), and
`set_machine_access` (`id`, `accessLevel`). Its
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

Onboarding starts with how he thinks, then guides phone pairing and a first
agent request. `/setup rooms` offers the Herdr workspace choice only when
doctor finds installed Herdr with running sessions. His own
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

Clankie reads any Claude Code, Codex, Grok, Pi or Prime Agent session from the
agent's own transcript, on this machine or an owner-configured SSH host. No
terminal host is involved: a session in Herdr, tmux, or a bare PowerShell tab
reads the same way
([ADR 0276](adr/0276-agent-sessions-read-from-their-transcripts.md)).

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
Reads are confined to `~/.claude/projects` (locally, every Claude profile's
`projects`: `CLAUDE_CONFIG_DIR`, `~/.claude` and each `~/.claude-<label>`),
`~/.codex/sessions`, `~/.grok/sessions`,
`~/.pi/agent/sessions` and `~/.prime/agent/sessions` (or
`$PRIME_AGENT_CODING_AGENT_DIR/sessions`) on that host and capped at 4 MiB per call. `local` is always present. Hosts are stored under
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
one "Past agents" entry. `clankie agents contacts` returns up to 1,000 display
identities through the existing fleet API, with live contacts first, followed by
recent contacts. Older identities remain in the durable store. A quiet fleet returns the usual
identity array. The display read has a five-second budget and retries a changing
fleet once. If it cannot finish, contacts returns `{ personas, readWarnings }`:
`personas` contains the last available identities; each warning names the pending
Herdr fleet (`herdr:FLEET_ID`), native projection, checkout observation, or changing
fleet consistency, with `timeout` or `changed_during_read`. These observations do
not confirm live ownership. The command's HTTP requests also have a twelve-second
transport deadline. Rename and role lookups refuse incomplete contact reads;
read again before making that change.

The fleet API accepts up to 768 occupied seats across execution connections,
independently of the 1,000-persona history bound. Native census reads do not
silently cut a connection off at 48 seats. Above 768 seats, the host refuses the
complete roster read with HTTP 503 `fleet_roster_limit` (count and limit)
instead of dropping seats.
Display capability checks reuse an exact native session ID or rollout path;
sending still rechecks the current process, session and delivery authorization.

Owner-started workspace membership reads cwd directly from the kernel through
the native process helper, with fresh process-lifetime and cwd rechecks. The
five-second membership budget remains unchanged; slow `lsof` startup no longer
consumes that budget. Missing or changed observations still refuse membership.

`clankie agents role NAME|PERSONA_ID ROLE|none [--project PROJECT]` assigns a current
member's role in the selected project. Omit `--project` for the default project.
The host verifies the agent's current native seat and project membership through
its original hire assignment or, for agents Clankie did not start, verified cwd;
offline agents, unknown membership and members of a different project are refused.
The assignment changes the project's semantic role, preserving the live harness
and its launch profile
([ADR 0208](adr/0208-agents-carry-a-role-the-world-reads-it.md)). The built-ins
`planner`, `designer`, `builder`, `tester`, `reviewer` and `researcher` are
suggestions; a custom role is 1–24 letters, digits, spaces and hyphens. Quote a
role with spaces: `clankie agents role Smith "sound designer"`. The role is the
last positional argument and everything before it names the agent. A name must match
exactly one agent, case-insensitively; otherwise pass the persona id from
`agents contacts`. Roles are trimmed, inner whitespace collapses, and a built-in
in any casing is stored lowercase. A custom role keeps the casing you typed
and compares case-insensitively, so `Sound Designer` and `sound designer` are
one role. `none` clears it in the selected project. It prints the updated persona
with that project's role. For example,
`clankie agents role "Pixel Smith" tester --project clankie` updates a Clankie
project member. Existing contacts' `role` remains the default-project compatibility
view; the confirmed project membership snapshot carries the selected project's
current saved role, including a cleared role.

World drops add an optional owner-write precondition to the existing routes:
`agents role ... --free-agent JSON`, `send --conversation ID --free-agent JSON`
and `work assign ... --free-agent JSON`. The JSON contains the exact `personaId`,
`seatId`, `occupantId` and `projectId`; a catalog-authored help message also
carries `helpTarget` with the original teammate's IDs and `paneId`.
The API field is `freeAgent`. It grants no authority: owner authentication,
project/tracker proof and existing delivery receipts still apply. The host
requires confirmed idle, no assignment or active goal, and observed zero running
children at its effect fence. Unknown or changed proof refuses the action.
Omitting the field preserves ordinary explicit owner commands, including the TUI.
Clients must never strip the field and retry a refused or uncertain drop.
The app holds the original action for four seconds with Undo before dispatch;
there is no inverse command or compensating write.

An explicit work-piece handoff may address a busy current worker. Use
`work write ID --owner NAME --work-handoff JSON` and
`send --conversation ID --work-handoff JSON` with the same exact `personaId`,
`seatId`, `occupantId` and `projectId`. The API field is `workHandoff`; it is
mutually exclusive with `freeAgent` and never relaxes that free-agent contract.
The host rechecks native identity and confirmed project membership before the
owner write and original note. Missing or changed recipients refuse; owner
authentication, tracker scope and receipt identity remain required. An applied
assignment followed by an uncertain note stays uncertain, without replay or
compensation.

`clankie agents role ROLE --project PROJECT` edits a project hire profile through
its revision-bearing owner API. Set any of `--harness`, `--model`, `--effort`,
`--subagent-model`, `--subagent-effort`, `--delegation native-first|panes`,
`--account LABEL`, `--placement new-tab|split`, `--cap N`, `--naming TEXT` and
`--mcp-servers NAME,...` (owner MCP servers this role's local hires may start).
`auto` for harness, model, effort, account, subagent model or subagent effort means no
preference: the field is saved unset, so the fleet default applies and, with
none, Clankie chooses per hire or leaves it to the harness. `inherit` clears any
field; omitted fields remain unchanged. The console's `/agents roles` menu sets
the same fields and shows unset launch fields as "no preference". A
`project update` changes file may carry `"model": "auto"` or `"effort": "auto"`
in a role, with the same result as omitting the field.

```sh
clankie agents role implementer --project clankie --harness codex --model "sol 6.1" --subagent-model "sol 6.1" --subagent-effort medium --delegation native-first --placement new-tab
clankie agents role implementer --project clankie --model auto --subagent-model auto --subagent-effort auto
```

Explicit hire fields expressing the owner's words win over the role, then
`fleet.hire` defaults; a model or effort no layer sets is left to the harness.
No harness is assumed: with none from the hire, role or fleet, Clankie chooses a
Claude or Codex worker for the job (`clankie fleet status` shows
`harness: no preference` in each role's `summary`). A hire that still names none
falls back to the hire machine's usable accounts the owner has not held: the
only harness with one, else Codex when its best account has more than half its
usage left, else Claude (its usage is not observable), within the family of any
requested model. No usable account refuses with each account's reason before a
pane opens; a resume keeps its saved harness. Omit fields to inherit; a model
family override includes its harness (for example `claude` / `Opus`) and
`subagents: null` clears incompatible inherited children for that hire. Friendly
names resolve to exact IDs against the current model registry. Missing, retired,
or incompatible models refuse instead of silently selecting a replacement.
Subagent settings inherit independently and travel in the first native brief;
the worker passes them to its harness's native spawn calls.

A `native-first` hire supplies a stable `deliverable` key, such as its issue ID.
All slices keep that key. Another pane for that project/deliverable is refused
while the original hire is live, starting or uncertain; message that worker and
use its native children. `panes` assigns independent slices to separate hires.
Closing a pane releases its admission only after successful inventory confirms
it absent. Retry reconciliation retains the original profile.

New hires use one Herdr workspace per repository on the selected fleet, even
when the lead or another client is focused elsewhere. Herdr's observed Git
identity groups linked worktrees of the same repo; equal directory names do not
group unrelated repos. A new workspace is built around only the newly allocated
hire pane, named from the repo, with no blank starter shell. The temporary hire
tab closes automatically when that pane moves. Existing labels and owner panes
are preserved; no older starter shell is inferred safe to close. On an entirely
empty server, the first hire retains the existing workspace-create path and
its starter shell, so a fresh install can still launch prepared hires.
An unmarked hand-created workspace is reused only when all its observed pane
directories belong to that repo. Mixed legacy workspaces stay untouched.
Non-Git directories use their exact working directory instead.

Omitted placement fills named 2x2 worker tabs, with at most four panes before
opening the next numbered tab. After a pane closes, a compacted layout that cannot be filled
starts a fresh numbered grid; surviving workers stay in place. Positions fill top-left, top-right, bottom-left,
bottom-right. The name defaults to the project's display name or deliverable (otherwise the
repository, or `Workers` outside Git); a per-hire `pipeline`, such as `"VUH-1869 authors"`, overrides it.
Hire `title` is the persona's human name. Optional `taskTitle` supplies a short
task caption: `title: "Wren", taskTitle: "Chats drawer"` gives a manual Herdr
pane label of `Wren · Chats drawer` on local and linked machines, for Claude
and Codex alike. Omitted `taskTitle` falls back to the role, then `Work`.
Issue keys, harness names and worktree paths are filtered out of captions;
work grouping reads seat assignments, never titles. The roster and pet strip
prefer the persona name alone. Harness terminal OSC titles (including Claude's
spinner) remain dynamic and do not change the manual pane label.

Explicit `new-tab` requests a solo `Name · task` tab. Explicit `split` requires
a pipeline and fills its grid. Existing unmarked pipeline tabs refuse instead
of appending to an unrelated lane. Existing owner placement preferences still
win; unset a `new-tab` preference to use the grid default.

Only tabs with matching repo/group/grid metadata are reused. Prepared native
initial-command hires create their own temporary tab and move only the new
pane into the group; their terminal and native process survive. Herdr's
same-tab `pane move` silently does nothing: sub-leads use the exact
[worker grid commands](../.agents/skills/clankie/reference/worker-layout.md).

This policy allocates new panes only. Resuming an already live native session
keeps its existing pane; a saved-session resume that needs a new pane uses the
same repo/tab rule. An explicitly requested move re-hires in a solo tab at the destination,
carrying its human name and known role; there is no automatic migration, rename or cleanup of older
workspaces, tabs or panes. The protocol `spawn_seat` request and `hire_agent`
accept the same optional `pipeline` field alongside `placement`.
Local and linked-machine hires choose the signed-in identity listed by
`worker_accounts` (its stable `label`/`accountKey`), then an existing home signed
into that identity. Discovery includes standard homes, the environment-selected
home and optional registered overrides. Existing profile aliases remain bound
to their original identity after a folder re-signs; an absent identity prompts
the owner to sign into that account and never tries another account. Usage and
holds follow the identity. Account selection confers no grants.
The identity registry owns a private `harness-account-identities/registry.json`
subdirectory of the captain state directory; existing readable state directories
need no manual permission change. An existing owned private registry file at the
old `harness-account-identities.json` path is copied once, retaining the original
as a backup and keeping file ownership and symlink checks.

The selected home reaches the pane and native harness as `CLAUDE_CONFIG_DIR` /
`CODEX_HOME`. Its identity is checked again before a new pane starts. Without an
account (or with `auto`), Clankie selects a usable, unheld identity by allocation;
an unavailable discovery refuses instead of silently using a default sign-in.
A resumed remote session keeps its saved home.

`clankie fleet set --hire-profile FILE.json` replaces all fleet hire defaults with the
same profile keys (`subagents` is `{model, effort}`); `fleet status` includes the
defaults and effective project role profiles. The hire result's `profile` shows
the effective launch preferences. These settings affect new hires, not running
agents. The owner's global agent instructions remain owner-authored.

`clankie agents rename NAME|PERSONA_ID NEW_NAME` changes an agent's saved display
name. Quote names containing spaces. `/agents rename NAME "NEW NAME"` is the
same TUI action. It uses the existing `update_persona` operation with only the
name; omitted appearance stays unchanged. Names support any language and the
existing 1–80 character/Discord webhook rules. Rename keeps the persona,
conversation, native seat and project assignment, including after a refresh or
resume. The app offers the same action in an agent's tray card.
Appearance and avatar updates may omit `name`; the service keeps the current
saved name, so an avatar finishing later cannot undo a completed rename.

`clankie agents roles` lists the built-ins (always, with counts), then custom
roles personas hold, most held first, each as `{ role, builtIn, count }`. Counts
include offline personas in the default-project compatibility view. The role is
semantic, unlike the cosmetic `appearance.accessory`, and persists as a project
association across seats. The same
settings are the `set_persona_role` operator op (`{ personaId, role: ROLE |
null, projectId?: PROJECT }`, steer grant; omitted project defaults to `default`
and requires the same current membership check), the `roles` op (read), and `hire_agent`'s and
`spawn_seat`'s `role` (required in the model-facing hire tool, optional for older API clients). In the TUI, `/agents role NAME "ROLE"` and
`/agents roles` opens the project hire-profile editor. The `/agents` picker shows each live agent's role.

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
than choosing another account by headroom. A local Claude resume launches in the
signed-in profile home whose `projects` holds its transcript; with no such
usable profile it refuses and tries no other. The TUI's saved-session actions offer
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
After an authorized same-thread native reattach, use
`clankie agents readopt SEAT_ID --conversation ID` (or the lead's `readopt_seat`
tool) to rebind the existing owner. The host proves the current native thread
and original owning conversation again; a different thread or owner is refused.
A same-thread `hire_agent` resume performs this rebinding under the admitted
hiring authority. Remote-attached local Codex panes without a Herdr session hook
are discovered from their exact foreground socket/thread and retained private
server lifetime; labels alone never establish a binding. Doctor reports
`linkedSession.nativeBindings` as observed, recovered, or missing.

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

### `agents efficiency` / `agents tidy-worktrees`

After assigning a follow-up by `message_seat`, record its issue with an
evidence-backed efficiency review's `deliverable`. A lead may also report
`ownedIssues: ["VUH-123", "VUH-456"]` for work its exact live native session or
subagents hold, including on linked fleets; `ownedIssues: []` clears that claim.
The daily check also counts an In Progress issue assigned to a configured human
owner (Linear owner user ID or email) as owned, even without an agent seat.
An assignee's display name alone does not establish ownership.
The daily ownerless-issue check uses explicit current native issue assignments,
or newer explicitly reassigned deliverables, plus these lead-reported live issues and running
native child labels naming exactly one issue. It never infers ownership from
ordinary message or report mentions. Claims vanish from the check when the
native occupant leaves; child/list claims alone do not authorize automatic
tracker settlement. Fleet observation completes before the daily check runs.

`clankie agents efficiency --conversation ID` returns `{ conversationId, seats }`
for every seat that conversation leads, including linked fleets. Each existing
roster seat may carry `efficiency`: observed assignment, native model and effort,
context occupancy, progress and reporting evidence, and plain-text `flags`.
`contextTokens` is the latest main-thread native model input for Claude and Codex,
including Claude cache reads and writes. Codex also retains `contextPercent` when
its native window is known. Context may age between responses and is unknown after
a compaction until the next model call. At 300,000 tokens a `context` flag asks
for the lead's judgment; it takes no action. `clankie fleet status` also reports
each seat's context tokens and context flag. Claude effort and OpenCode or remote
telemetry remain unknown. Original report acceptance or a reporting attempt remains progress after
a later acknowledgment; acknowledgment creates no new progress. The TUI shows
these flags in the agent dock. Every watch wake calls for reviewing all owned
seats. Periodic checks default to every 30 minutes; unchanged, unflagged evidence
skips a model turn, and pending reviews coalesce. Wake prompts carry bounded summaries; use
`fleet_efficiency` or the CLI to inspect the full owned roster. Clankie chooses
interventions using the `lead` skill and his existing native worker tools.
Automatic commit evidence requires an advanced descendant HEAD on the seat's
captured branch in an exclusive linked worktree. Primary checkouts, shared
worktrees and commits predating admission do not establish that seat's progress.
Native transcript snapshots are cached by file identity, size and modification
time; unchanged branch HEADs reuse Git evidence. Discovery runs once in the
background instead of walking transcript directories during roster refreshes.
Concurrent roster reads share one refresh and may reuse a completed result for
one second while its change cursor is unchanged. Codex child discovery caches
the parent rollout and discovery-directory stats and uses asynchronous reads;
unchanged sessions avoid another tree walk. Authority-sensitive and post-mutation
reads force fresh observation; the display cache grants no native control.
To change an external worker's effort, ask that worker or re-hire with a retained
handoff; captain model settings do not change the worker.

After inspecting a worker's actual assignment, tracker status or progress evidence,
record the finding with:

```bash
clankie agents efficiency review SEAT --conversation ID --json-stdin < review.json
```

The JSON object requires `evidence` (1–2048 trimmed characters). Optional fields
are `offScope` (boolean), `assignmentStatus` (`active`, `paused`, `canceled` or
`done`), `deliverable` (1–512 trimmed characters), `ownedIssues` (up to 100 exact
issue keys, such as `["VUH-2026", "VUH-2108"]`; `[]` clears the claim), and `progressAt` (a UTC ISO
8601 timestamp for the substantive finding or commit). The CLI supplies the
action, seat ID and conversation; extra JSON keys are refused. A review applies
to that exact owned native session and records inspected evidence. It does not
change tracker state, harness settings, ownership or report receipts.

Both forms answer within 25 seconds, under the CLI's 30-second abort, from one
fresh census. A fleet that misses that deadline or fails its census is named in
`readWarnings` (`timeout` or `unavailable`): its seats are unknown, not absent.
A linked fleet whose census just failed is skipped (still `unavailable`) by
later censuses instead of costing each its transport deadline again; Clankie
reprobes it in the background, backing off from 5 to 30 seconds, and reads it
again once it answers or its connection changes.
When the census misses the deadline, `show` returns the last completed
projection with that warning, and a review is refused with `Review not
recorded; nothing was written` and never applied later. A recorded review
returns `review: { seatId, occupantId, reviewedAt }`, and the seat's
`efficiency.reviewedAt` carries the same time; after a call ends without a
response, `show` tells whether it was recorded.

The authenticated operator API is POST `/v1/fleet/efficiency` with
`{ action: "show", conversationId }`, or the review fields plus
`{ action: "review", conversationId, seatId }`. The model's `fleet_efficiency`
tool uses the current leading conversation. Ownership changes or unavailable
evidence refuse a review; there is no default-conversation fallback.

`clankie agents tidy-worktrees --repo /canonical/repository/path
[--merged-into REF]` lists linked worktrees that are clean and merged into the
locally saved ref (`origin/main` by default). The API is POST
`/v1/fleet/tidy-worktrees` with `{ repository, mergedInto? }`, and the lead tool
is `list_tidy_worktrees({ repository, mergedInto? })`. All return
`{ outcome, mergedInto, candidates, excluded }`; candidates contain `path`,
optional `branch`, and `sha`, while excluded entries contain `path` and a reason.

Listing is read-only. It excludes the main checkout, locked or prunable entries,
dirty or unmerged worktrees, and worktrees occupied by any observed local pane
(`live_pane`, including idle agents and shells) or process (`live_process`). A
pane or process cwd holds the worktree it is in and the worktrees nested below
it, unless that cwd is `$HOME`, an ancestor of `$HOME`, or above the
repository's main checkout. Those protect nothing below them on their own
([ADR 0280](adr/0280-automatic-tidy-requires-positive-work-proof.md), VUH-2926).
Unknown or changing pane inventory, or an unavailable process census
(`process_inventory_unavailable`), returns `outcome: "unavailable"` with no
candidates. A process that starts in a candidate during the listing holds only
that tree. On Linux the census skips processes whose cwd the kernel withholds:
other accounts' processes and our own non-dumpable ones, such as `systemd --user`. The command does not fetch refs or
prove ownership. Use the `tidy` skill to harvest results, verify ownership and
fresh merge/clean evidence, then remove finished owned worktrees after landing.

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

`prepare NAME [--codex-source-setup ABSOLUTE_REMOTE_SCRIPT]` readies the
machine's Claude and Codex workers; running it is the owner's approval. It ships
this Clankie's own worker bundle to `~/.clankie/claude-plugin`, installs/enables
Claude in each discovered profile, and approves its worker channel in managed
policy (`C:\Program Files\ClaudeCode\managed-settings.json` on Windows), keeping
existing entries. Codex uses its native `clankie-worker@clankie-fleet` plugin.
A source-managed Codex config requires its source manager, selected with the
remote setup option; Clankie never writes through its symlink. See
[linking native fleet harnesses](#linking-native-fleet-harnesses) for the setup
contract and dotfiles example. Preparation reports incomplete native worker
checks as failure, even if a legacy Codex MCP registration is present.

Policy is machine-wide, so the SSH account must be that machine's administrator.
Rerun preparation after an update to ship the matching plugin. Its API is the
operator-only `POST /v1/runtime-connections/NAME/prepare`.

For the active local external Herdr session on Mac, prepare only the automatic
Claude launcher with `clankie herdr prepare local --claude-path-shim install`.
It uses the same machine setup policy and operator API, with
`claudePathShim: "install"` and connection ID `local`. It sets the stable
Clankie-owned zsh shell under `~/.clankie/herdr-pane/SESSION`, preserves the
config symlink and all other settings, and reloads config for new panes.
Plain `claude` and `claude --resume ID` then opt into the enabled worker channel.
Explicit channels/settings, bare/print/administrative launches and disabled
plugins pass through. Existing panes and sessions keep their launch settings.
`--claude-path-shim remove` (API `claudePathShim: "remove"`) restores the prior
shell selection; owner edits made since installation are preserved. Existing
custom shell launchers are refused. Bundled zsh panes are prepared at service
start. `doctor` reports `herdrPlugin.claudePathShim`; PATH activation is setup
evidence, separate from the live receiver observation. See the
[shim setup and limitations](../integrations/herdr-plugin/README.md#hand-started-claude-on-mac).

What crosses the link, and what cannot:

- Every call runs `herdr --session SESSION <verb> …` on the remote host with an
  exact argv (a Windows command line is built for `CommandLineToArgvW` and
  handed to `ProcessStartInfo`, so PowerShell never parses it). One multiplexed
  ssh connection per fleet carries them through service-owned control sockets
  under `~/.clankie/ssh/` (`ControlPersist=600`). New service lifetimes and
  connections older than ten minutes use a fresh socket. A failure before the
  remote program starts retries once with a fresh login environment; failures
  from an already running program are reported without replaying the command.
  The resident Windows relay is not renewed: it keeps its published link port
  until a real outage, and reads the machine and user PATH from the registry
  before each command, so a remote install or PATH change applies to the next
  observation. Retired masters retain
  existing clients and expire when idle, leaving other SSH sessions intact.
  PowerShell progress is suppressed and serialized errors are decoded before
  appearing in link status and logs.
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
  Once its visible TUI binds a native thread, a dropped service SSH controller
  leaves the detached Windows backend running. After restart, the first send
  discovers its kernel listener from the TUI's native `--remote` endpoint,
  checking installed executable, process lifetime, pane/socket/home markers,
  working directory and the actual forwarded connection again before input.
  The service's former launch registration is not reconstructed. If the
  backend has exited, re-adoption cannot bring it back: the refusal asks the
  owner to end the stale TUI, then resume the saved session with `hire_agent`'s
  `resume` reference and a new dedicated backend. It never restarts the existing pane automatically.
  Private catalog readiness reads the pinned `worker` server on the original
  loaded thread. A newly named native root can have metadata before its rollout
  materializes. Observer subscription and history hydration stay distinct:
  only an exact fresh, idle, non-forked root created during this view's startup
  on an initially empty server may defer the exact missing-source-rollout read
  before its first dispatch. Freshness uses confirmed post-name metadata:
  Codex 0.160.1 synthesizes a read-time creation timestamp until naming persists
  the root's actual creation time. After dispatch, history is required; a later read
  failure is uncertain and never replays input. Saved, forked or corrupt history
  remains refused. Unproven creation metadata or an out-of-window host clock
  cannot grant deferral. A pre-dispatch refusal returns `briefDelivery: "not_sent"`
  with `deliveryStage: "unavailable"`; its native view and launch receipt remain
  retained for inspection. Retrying that hire does not send its brief or create
  another worker. Failures after the native turn RPC retain uncertainty.
- A remote Claude hire uses the `clankie-worker` plugin there, as a local one
  does: its fresh brief is a private file referenced by the native startup prompt, follow-ups use the
  plugin's channel, and its hooks report each settled turn. Messages and hooks
  travel over the fleet's **link**, which the
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
  The roster exposes `workerReportBridge` separately from tool health: the last
  `stored`, `uncertain`, `rejected` or `unavailable` outcome, observation time,
  fixed safe reason, and last confirmed stored time when observed. `doctor` and
  the console show it. A hired seat held idle or done for 15 minutes without a
  stored report since its last brief carries `finished, unreported`. Three
  distinct failed seats within ten minutes produce one native alert to their
  owning lead, rearmed after recovery; raising it spends no service-model turn.
  Both `mcp --seat` and `mcp --fleet` preserve an uncertain original across
  bridge/service replacement. Calling again reconciles that exact ID through
  a read; it never resends it. A different follow-up during reconciliation
  remains unsent, except that a peer message goes out once its original has
  settled, carrying that outcome as `previous` (VUH-2779). Missing or mismatched evidence stays blocked; do not delete
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
and durable memory, and clears the conversation's pending wake and watches.
The transcript and Pi session remain in `conversation-archives/reset-UUID`,
beside the service's `conversations` directory. JSON returns the fresh
`conversation` and `archiveId`.

Reset requires an idle conversation with no open side conversations. A root
bound to an external seat refuses reset: end that seat first because its
model context belongs to the external harness. The API's `reset` operation
requires `expectedRevision`; stale requests refuse without changing history.

<a id="routines"></a>

### Routines

```sh
clankie routines                      # list, with next and last run
clankie routines add "Morning triage" --when "every weekday at 9:00" --turn "Triage new KH2 issues"
clankie routines add "Cleanup audit" --when "every friday at 17:30" --conversation ID \
  --hire '{"title":"Ada","role":"builder","workingDirectory":"/path/to/repo"}' --brief "Run the weekly dependency audit."
clankie routines add "Typecheck" --when "every 2 hours" --check --cwd /path/to/repo --report failure -- pnpm typecheck
clankie routines edit ID [--name NAME] [--when WHEN] [--tz ZONE] [--missed catch_up|skip]
clankie routines pause|resume|run-now|remove ID
clankie routines history [ID] [--limit N]
```

A routine is a recurring job (ADR 0265). `--when` takes plain language ("every
day|weekday|weekend|monday[, friday] [morning|evening] at 9:00|9am|17:30",
"every N minutes", "every N hours", "hourly") or five cron fields; an
unrecognised phrase is refused. The time zone is the machine's unless `--tz`
names an IANA zone. Targets:

- `--turn PROMPT`: a turn in the conversation (default: Clankie's main chat).
- `--hire JSON --brief TEXT`: a hire with `hire_agent`'s fields, led by that
  conversation; the lead hears which seat was hired, or why none was.
- `--check --cwd DIR [--timeout SECONDS] [--report always|failure] -- CMD…`: the
  command runs through `clankie heavy`; the conversation hears failures, or every
  result with `--report always`.

`--missed catch_up` (default) runs once after the Mac slept through runs and
says how many it stands in for; `skip` logs them and waits for the next slot.
Each slot is claimed once before it runs, so restarts and overlapping deploys
never run it twice; a run a restart cut short is logged `interrupted`, not
replayed. A run never overlaps the same routine's previous run. `--paused` adds
a routine disabled. Output is text; `--json` prints the `RoutinesStatus`.

The local operator credential, or a paired device with Take Control through the
relay, authorizes `GET /v1/captain/routines` (list) and
`POST /v1/captain/routines` with one `RoutineCommand`: `list`, `add`, `edit`,
`pause`, `resume`, `run_now`, `remove`, `history` (schemas in
`packages/protocol/src/routines.ts`). Invalid commands and unrecognised schedules
return 400, an unknown id 404, and a run already going 409. In the TUI, bare
`/routines` lists routines with run-now, pause/resume, history and remove, and
adds a lead-turn routine; `/routines` also takes the CLI arguments. The app lists,
adds, edits, pauses, runs and removes them under Settings > Routines, and the
desktop pet's menu runs, pauses and resumes them. Leads manage routines that
target their own conversation with the `routine` tool.

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
Native `claude`, `codex`, and `opencode` launches accept the same selectors with
`--conversation`; use the stable ID when room names are ambiguous. Room names
include the server and channel, or the DM peer, when the Discord transport
provides them; retained rooms without names display their target IDs.

Discord room records are read-only: use Discord to send messages. Their
transcripts include model-visible context and bounded, redacted tool details;
source-session entries identify the original local Pi journals for deeper
inspection. Voice rooms contain captain handoffs, not unrecorded ambient voice.
The existing authenticated conversation API provides these same list/get/replay/tail
operations. See [ADR 0176](adr/0176-every-room-is-an-inspectable-conversation.md).

Room handoffs also appear as separate child records with `roomHandoff` metadata
and in the fleet snapshot's `roomHandoffs` array. Use their child conversation ID
with `show` or `tail`; the original `roomConversationId` identifies the asking
room and its delivery evidence. The inline TUI dock shows active jobs above
fleet seats; `Ctrl+G` retains finished jobs and their results in its picker.
The app collapses finished jobs behind an explicit expansion control.
The recorded `host` is the actual executor: all non-owner work under a Codex
head runs on Pi with the original room authority and grant. Only the verified
owner's work uses native Codex children. Completed delivery retries return the
saved result. See [ADR 0229](adr/0229-room-handoffs-are-visible-parallel-threads.md).

### `conversations continuation ID [MODE QUESTION]`

Lead continuation is declared through the conversation autonomy API or
`clankie conversations continuation ID [active|paused|complete|blocked_on_owner QUESTION]`.
With no mode, it reads the current declaration and wake. A blocked declaration
requires a question; other modes carry none. Leads can use `report_continuation`
or a settled report line `Blocked on owner: <question>` or `Continuation: active`,
`Continuation: paused`, or `Continuation: complete`. Quoted text does not count.
The service alerts after three minutes of confirmed idleness with an open
blocking decision, or active work with no self-wake or live workers. Completed
and intentionally paused work is excluded. Idle epochs and opening/recovery
dedupe persist across restart; unavailable state remains unknown. No approval,
wake or repair is performed automatically.

### `conversations lead prepare FLEET | launch --json-stdin | revoke ID`

Start a fresh native Claude project lead on a linked Windows machine. The machine
needs Node 22 or newer, native Claude and Herdr; no Clankie installation is needed.
The registered fleet must permit `workers` and approve the exact working directory.
The owner-authenticated API is `POST /v1/remote-leads/{prepare,launch,revoke}`.

`prepare FLEET` projects the standalone operator bridge into a content-addressed
`~/.clankie/remote-leads/` directory. Source checkouts first build the bridge with
`clankie heavy -- node scripts/build-remote-lead.mjs`; runtime updates build it
before service cutover, and releases include it. A missing bridge returns a
503 with that build command rather than an opaque 500.

Launch uses an existing signed-in Claude.ai identity on the PC. Optional
`account` is the stable identity key (`label`) from `worker_accounts --fleet`;
legacy profile aliases stay bound to their originally discovered identity.
The service selects a current home for that identity and the bootstrap verifies
its native non-secret identity before preparing the lead plugin or making a pane.
Missing, logged-out, changed or unverifiable identities refuse with a sign-in
prompt; no other account is tried and no credentials are copied.

A relaunch into the same conversation, fleet and workspace reuses the last
completed launch's recorded identity when `account` is omitted. An explicit
identity overrides that choice. A fresh launch chooses a usable, unheld identity
from the same account discovery and allocation as worker hires.

Before allocating a pane, launch installs the content-addressed plugin through
the native `clankie-remote-leads` marketplace and additively approves its channel
in the PC's managed policy, preserving other entries and permissions. The SSH
account must be able to write that policy as the PC administrator. An explicitly
disabled channel policy is refused. Setup failures return a diagnostic in the
launch journal before allocating a pane. Plugin activation is session-only:
the installed lead plugin is disabled for ordinary sessions, and this launch
enables it with `--settings` and `--channels`, without the development prompt.
The session allows its own delegated lead MCP tools, including `message_seat`,
so auto mode can use them without a classifier prompt. This adds no shell or
other plugin permissions and does not depend on maximum trust mode.
It also disables inherited Clankie worker/operator plugins for this session,
so their hooks do not bind the lead as a worker or suggest its worker channel.
Setup also installs Herdr's Claude integration into the selected profile when
it is missing (`herdr integration install claude` under that
`CLAUDE_CONFIG_DIR`): Herdr learns the lead's session only from that hook, and
without it every lead request is refused as unproven. A profile Herdr cannot
hook refuses before allocating a pane, naming that command. Setup clears a
stale "needs auth" verdict that native Claude records for the lead's MCP server
after an earlier bridge timed out, which would otherwise skip the bridge in
every later session of that profile. A profile that has not finished Claude's
first run (`hasCompletedOnboarding`) refuses before allocating a pane, naming
the owner step: run `claude` once under that `CLAUDE_CONFIG_DIR` and complete
its first screens. The lead starts with `--no-chrome` to disable browser tools;
fresh-profile first-screen behavior remains a separate live verification.
SessionStart prompt and transcript hooks retry a restarting service for up to
50 seconds, inside the native hook's 60-second budget. Explicit revocation
stops the retry. Other transcript hooks retain a two-second upload budget and
leave unacknowledged records for the next hook.

`launch --json-stdin` reads an object with a fresh UUID `requestId`, `fleet`,
`workingDirectory`, `title`, and optional `account` and `conversationId`. Omit the conversation
to create a named workspace chat; otherwise select an unoccupied workspace chat
with that exact directory. The service prepares the plugin and allocates a fresh
Herdr workspace. The result includes the conversation, pane and `delegationId`.
`dispatched` means the launch handoff completed, not that Claude's tools or channel
are ready. Inspect the chat and its native head. An `unconfirmed` result must be
reconciled using the same request ID; repeating it reads the original journal and
never launches again. Do not substitute a fresh ID for uncertain intent. An
`unconfirmed` result's `detail` names the pane it left open, if any. The remote
helper reports a created pane before native shell inspection; a failed
inspection still retains that pane in the receipt, without issuing a delegation.
If transport fails before any pane report arrives, allocation remains unknown;
the receipt must be reconciled rather than replayed. A result
also lists in `leftBehind` the panes that earlier launches for the same
conversation left in the past day; close any whose head never attached.

`revoke ID` invalidates the delegation immediately. Subsequent tool calls and
channel access fail; an already dispatched effect cannot be undone. Explicit
revocation survives restart. Temporary bridge, relay or native-observation loss
is retried; a service restart re-arms only a previously proved launch with the
same machine, pane, shell and harness process lifetimes, native session and chat.
A launch that had not proved its native process before shutdown returns
`remote_lead_launch_unproved`. Its bridge stops retrying and names the required
fresh launch; it leaves the original pane open.

Workspace grant changes preserve a connected lead whose own working directory
remains granted. Connection identity (machine, SSH, kind, session and enablement)
stays pinned; each request separately checks the lead's own directory grant.
An invalid binding returns `remote_lead_binding_unavailable`; a removed directory
grant returns `remote_lead_workspace_revoked`, both with recovery instructions.
Report link failures to the Mac lead or owner for a fresh launch from the Mac
after approval is restored. Never work around them with Mac desktop control or
credential rotation. Delegations issued before this identity-hash change also
need a fresh launch; their old hashes are not migrated or relaxed.

The head's transcript hooks retry a failed seat sync after 2 and 5 seconds and
stay silent until three hook runs in a row fail; the lead's pane then shows one
line naming the error. Every hook run is recorded on the PC in
`~/.clankie/remote-leads/hooks.log` (rotated at 256 KiB, never holding the launch
secret) with its event, exit code, duration and full error. A running head picks
up new hooks only when it is launched again on the updated plugin.
An exited or replaced head is never re-armed. The bridge keeps the native MCP
connection open and refreshes its idle upstream without replaying tool effects.
`clankie doctor` lists each known seat bridge by the lead chat’s name, including
reconnecting and disconnected channels. The fleet round’s lead roster shows the
same receiver state and whether `message_seat` is available.
Private service records store only token hashes and host proof. The bearer token
is delivered in memory, never in plugin files, arguments or receipts; OS paging and administrator memory access
are outside this guarantee. The bridge delegates project lead tools and messaging
with the selected chat's attribution, not general owner HTTP or settings access.
It also exposes ordinary `linear_*` tracker reads/writes and tracker-only
`mcp_tool_search` / `mcp_tool_call`. Deferred calls cannot reach another service;
raw GraphQL, owner repository overrides and persona-selectable worker publishing are excluded. Tracker
writes require current delegation and proved chat attribution at dispatch.
`linear_wake` accepts only `action: received` with the chat's original `wakeId`.
The owner routes the project's wakes with `linear routes set --json-stdin`,
preserving other project routes. Verify an issue read and comment from the live
head after redeploy/relaunch; a fixture pass does not prove that acceptance.
`clankie status` reports a recently interrupted seat bridge as `reconnecting`,
then `current` when the original head resumes its current-protocol polls. An
unrecovered bridge eventually reports `disconnected` with an explicit recovery
reason; status alone never proves that an exited head can attach again.

Remote Codex heads and in-place worker conversion are not implemented. Preserve
an existing worker's written handoff and original session reference, launch a new
project head, then deliver that handoff through the chat. Coordinate any worker
adoption or retirement separately; launch never restarts existing panes.
See [ADR 0259](adr/0259-remote-project-leads-use-seat-bound-delegation.md).

### Native pending messages and Stop

`clankie conversations pending ID` lists host-owned native messages in admission
order, including each original `messageId`, `version`, text, timestamp and state.
New `send --conversation ID --delivery queue` submissions to controllable native
seat/persona chats (or an attached native head) stay on the host until the original
seat is idle. They return the original ID as `runId` and `seatDelivery.state: queued`.
No model turn is spent to store or control a message.

```sh
clankie conversations pending ID edit MESSAGE_ID --version 0 --text "Revised request"
clankie conversations pending ID remove MESSAGE_ID --version 1
clankie conversations pending ID send-now MESSAGE_ID --version 1
clankie conversations stop-task ID
```

The authenticated conversation dispatch operations are `pending_messages` with
`{conversationId, command: {action: list|edit|remove|send_now, ...}}`, and `stop_task`
with `conversationId`. Mutations select the original `messageId` and
`expectedVersion`; edit also supplies `text`. The shared protocol client exposes
`pendingMessages` and `stopTask`. Devices require `terminalControl`; local CLI
uses the operator credential. Authority and the exact native occupant are checked
again before dispatch. A bare captain bearer cannot control these messages.

Message states are `queued`, `dispatching`, `picked_up`, `removed`, `uncertain`
and `unavailable`. A native acknowledgment establishes pickup, not completion of
the agent's work. Edit and remove act only before dispatch; send-now consumes the
same original instead of submitting a replacement. A competing pickup returns
`conflict`. Uncertain dispatches block automatic later pickup in that conversation
and are never resent. Host restart retains queued originals but requires a fresh
explicit send-now; an interrupted dispatch restores as `uncertain`. Expired
admission authority never permits a background send. Each conversation retains
up to 100 originals/outcomes, with at most 1000 across the host; settled history
is trimmed first. Earlier messages already admitted to a native harness's queue
are not imported or resent by this API.

Queue requires an original live adapter with an authoritative status and safe
send channel. Controlled Claude and Codex seats supply that boundary. Pi, OpenCode, Grok
and external sessions without that controller cannot admit this host-owned Queue.
Service-owned Pi queues keep their existing run cancellation. Stop currently
supports **controller-owned Codex** through its exact native `turn/interrupt`
RPC and terminal-turn observation, and **controlled interactive Claude** through
one Esc in its own pane (VUH-2680). It returns `stopped`, `already_finished`,
`unsupported`, `unavailable` or `uncertain`. A natural completion race returns
`already_finished`; a missing native terminal receipt returns `uncertain`, and
that controller retains the original stop attempt. Claude's Esc goes out only
while Herdr shows that exact pane, terminal and session working and its styled
input line is provably empty; an idle seat returns `already_finished`, and a
draft, an unreadable input line, a seat waiting on the owner or a changed
binding returns `unavailable` without a key. A confirmed draft includes typed
`reason: "unsent_draft"`; Stop leaves that text intact. Open the agent's terminal
to review it. Clients match the reason, never the diagnostic `detail`.
Typed reasons are opt-in on the `stop_task`
request (`includeReason: true`); the default result retains the shipped strict
shape. An old service/relay rejects that field with HTTP 400 before dispatch;
clients may retry that schema refusal once without it, never another failure
or lost Stop response. Unexpected errors after dispatch return `uncertain`,
never HTTP 400. Owner authority and the binding are
checked again just before the key. Exactly one Esc is sent per stop, concurrent
requests share it, and `stopped` needs Claude seen idle within five seconds;
otherwise the result is `uncertain` and nothing is repeated. Claude's draft
check is the last read before the key. Herdr cannot tell an interrupt from a
turn that finished on its own in the instant before the key landed, so that
race also reports `stopped`, not `already_finished`. A confirmed stop settles
the hold captured before Stop as waiting, so a Queued message goes out at once
instead of waiting for expiry (Claude's Stop hook does not run after an
interrupt). A new session, an explicit `UserPromptSubmit` start (`turnStart: true` on
seat-sync), or any channel take after capture keeps its own hold, even in the
same session. A late tool-progress sync continues the stopped turn and does not
invalidate its settlement. Channel takes include Steer, so a take during Stop
conservatively keeps the hold until a later turn-end sync or expiry. Older
services accept seat-sync's retry without the new start marker, but do not gain
this race guard until updated.

Every device sees a stopped Claude turn as the existing `turn` event with
`phase: "cancelled"`, `reasonCode: "native_interrupted"` and the summary
"Stopped before it finished." It comes from Claude's own interrupt record
(`[Request interrupted by user]`, or `… for tool use]` after a rejected tool),
whichever surface pressed Esc. The run ID is derived from that record, so a
replay or a second sync never adds another, and it never counts as an active
run. An Esc before Claude has replied writes no record: Claude puts the prompt
back in its input instead, and no marker is published for that turn. A service
older than this entry refuses a hook upload containing it; `clankie seat-sync`
then resends that page without it. External Codex
sessions, Pi, OpenCode and Grok currently return `unsupported`; there is no
signal, pane-close or replacement-session fallback, and no other terminal key.

The app's pending bubbles and Stop presentation are a follow-up in `clankie-app`;
the service/CLI contract does not claim iPhone/iPad UI validation.

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

Service preparation and execution have a five-minute inactivity watchdog,
including cold startup before a Pi session exists. Host-observed preparation
progress and Pi events renew it. The watchdog is suspended while one or more Pi
tools execute; tools retain their own timeout and cancellation behavior. A full
five-minute idle window resumes after the last tool ends. Before execution starts,
or with no active tool and no preparation or streamed progress, inactivity still
times out after five minutes. Healthy work has no total duration cap, and queued
runs do not consume the timeout while waiting. A stalled stored run fails
with `conversation_turn_stalled`; the service log names its conversation, run ID
and stalled phase. The host releases its admission so later inputs can proceed, but its
original receipt remains and the request is never replayed. A stall during Pi
compaction marks that session as abandoned. The next durable service turn (including
Discord) uses a fresh session seeded from a bounded conversation-log projection;
the old session and log remain evidence. Queued inputs drain into the fresh session
rather than retrying compaction against the same oversized history (VUH-2463).
Earlier effects may
have an unknown outcome; inspect the original run before retrying. See
[ADR 0218](adr/0218-native-seats-drive-their-attached-conversation.md#stalled-service-preparation-and-execution-vuh-1613).

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

### `prompt [--lane LANE] [--sections identity,persona,reach,fleet,address,model,conversation] [--conversation ID] [--harness claude]`

The system prompt that lane's session starts from, printed verbatim as plain
text. The intended consumer is a seat launcher in another harness, which reads
it once at startup so the seat begins from the same words the service lanes do.

`LANE` is `operator` (the default), `discord_voice`, `discord_presence`, or
`gameplay`, and must be the lane the bearer speaks for. The operator bearer
comes from the credential broker, so this reads the operator lane.

Sections default to the five a session is built with, joined by one blank line:

| Section        | What it is                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identity`     | `instructions.md` — who he is, his trust boundaries and where things live                                                                                                                                                                                                                                                                                                                                                           |
| `persona`      | The owner-authored character configuration                                                                                                                                                                                                                                                                                                                                                                                          |
| `reach`        | The machine-access or this-room paragraph for that lane; with machine access, the ready computer-use harnesses (`browser harnesses`) unless delegation is off; in Discord lanes, how a reply carries media                                                                                                                                                                                                                          |
| `fleet`        | Current fleet budget, effective project closure and machine setup responsibility, and optional routing notes; machine-holding lanes                                                                                                                                                                                                                                                                                                 |
| `address`      | His own mailbox, when one is connected                                                                                                                                                                                                                                                                                                                                                                                              |
| `model`        | The card naming the model the service lanes run on (ask for it by name)                                                                                                                                                                                                                                                                                                                                                             |
| `conversation` | Operator lane only, by name: a bounded projection (about 24k characters, newest first, printed oldest first) of the selected conversation's log — messages and finished tool actions from every harness and the service lane. Reading it records the projected cursor, so a later reconnect handoff starts after it ([ADR 0218](adr/0218-native-seats-drive-their-attached-conversation.md#the-log-is-the-conversation-2026-10-06)) |

A seat that carries the identity some other way asks for the rest:
`clankie prompt --sections persona,reach,address`.

With a selected conversation (`--conversation` or `CLANKIE_CONVERSATION_ID`),
the prompt ends with that workspace's project instructions. `--harness claude`
leaves out what Claude Code loads itself: every `CLAUDE.md`, and any `AGENTS.md`
with a `CLAUDE.md` beside it. An `AGENTS.md` that stands alone is kept, since
Claude Code never reads it. The Claude seat's hook also leaves out `fleet`: the
lead skills read it from `clankie fleet status` when they need it.

### `memory [status] | search <terms...> | forget <episodeId> | correct <episodeId> --summary TEXT`

Inspect and curate notes through the operator API. Output is JSON; success
exits 0 and failure exits 1. `status` shows the newest 20
notes, including private notes. `search` matches all supplied terms against
the note, source lane, and room, returning up to 20 newest matches and the total
matched count. Quote a correction's summary as one shell argument.

Notes stay until forgotten, without a retention flag or count quota.
`correct` replaces the note while preserving its source and date.
`forget` deletes the note. `/memory`
exposes the same controls in the console. See [Memory](memory.md) for lane
privacy and migration behavior.

### `metrics --app`

Read operator-only `GET /v1/app/metrics` for Release app navigation timings.
`app.devices` separates authenticated device IDs and closed platform names;
`summaries` gives each destination's rolling sample `count`, nearest-rank
`firstFrameMs` and `longTaskMs` p50/p95 in milliseconds, and `slowCount` (first
frames over 100 ms). A null long-task measurement means unsupported, never zero.
These are client-reported last-64 windows, not averaged fleet percentiles.

Paired clients POST complete snapshots to `/v1/devices/self/app-metrics`.
Only fixed destinations, timings and counts are accepted; the current session
supplies the device ID. Reports are at most 4 KiB and eight destinations.
Updates faster than once per second per device/platform return 429. The service
keeps at most 64 device/platform snapshots, evicts the oldest, drops snapshots
idle for an hour or belonging to revoked/expired automation devices, and resets
on restart. There is no content, device name or durable activity history.
See [the decision](adr/0290-app-switch-metrics-are-bounded-device-reports.md).

### `metrics --fleet`

Local native workers on Linux use the same kernel-backed admission route as
Darwin. Linux v1 requires the initial host PID namespace and genuine, visible
procfs; containers refuse with the fixed reason `unsupported_pid_namespace`.
Read that reason here or in doctor instead of supplying a PID or token to bypass
the refusal. Hosted container admission remains a separate follow-up, VUH-2120.
See [the native proof boundary](../integrations/fleet-proof/README.md#linux-host-boundary).

Read operator-only `GET /v1/fleet/metrics` for proof attempts and refusals, worker
report attempts and failures, and fixed native/transport reason counters. The
five- and sixty-minute windows show failure fractions and failures per minute;
counters contain no process IDs, paths, argv, report bodies or credentials.
Doctor includes the same aggregate windows. `callers` adds five-minute windows
for up to 512 syntactically valid `claimedPane` labels, sorted by refusals. These
are request claims, not authenticated identities, and never affect admission.
Invalid/missing claims and overflow still count in aggregate totals. Inactive
caller entries expire after five minutes unless an unresolved alert holds them;
those held entries can have empty windows. Native/transport diagnostics remain
separate from terminal refusal counts, including within each caller window.
More than 1% terminal proof refusals in five
minutes produces an alert once that window has at least 100 attempts and five
refusals and stays elevated for at least one minute. Every refusal still counts;
startup and high machine load do not exempt callers. Sparse or transient bursts
remain visible in metrics without paging the owner. The aggregate alert goes to the owner's default conversation,
including refusals without an identifiable or currently owned pane. A live seat
also alerts its current owning lead under the same sample/persistence rule.
While an aggregate alert is pending or in its five-minute cooldown, workers
sharing its cause are listed in that alert instead of paging separately.
`native_initial_unavailable` and `native_final_unavailable` count as one native
proof outage. A worker remains separately actionable when its refusal rate is
at least twice the fleet rate and at least five percentage points higher, or
when a non-majority cause accounts for at least 20% of its refusals and is
rare fleet-wide (under 10%) or at least 25 percentage points more prevalent
for that worker. Workers with the same exceptional cause share one alert and
its five-minute cooldown. Large pane lists are bounded in the message; the
full claimed labels remain in `clankie metrics --fleet`.
A worker alert names the pane and its observed harness; its window counts only that caller pane;
the aggregate window matches `clankie metrics --fleet` at the alert timestamp.
Later metric reads can differ as checks arrive and minute buckets expire.
Aggregate alerts are retained as service
notices even when no native seat can receive them. A definitively unavailable
native route starts the aggregate five-minute cooldown after retaining that
notice; an exact native acknowledgment starts the cooldown for delivered alerts.
A submitted but
unconfirmed alert stays held across inactivity without replay; later proof
observations read only
its original acknowledgment before starting that cooldown. Unavailable delivery
may retry after one minute. Native retries are counted separately from terminal
refusals. In particular, `process_unavailable` with ESRCH and `socket_unavailable`
with EBADF can be retryable census churn; their presence does not establish a
failed proof. Only the terminal proof result increments attempts/refusals. An
exhausted retry, timeout, identity mismatch or failed observation still refuses
and counts. `caller_exited` means the socket claimant's exit was confirmed at the
failed ancestry read. `ancestor_exited` means an intermediate exited while the
same claimant lifetime was freshly proven live. These fixed reasons appear in
native counters and, for a terminal refusal, proof counters; an intermediate
exit never proves current membership. Metrics restart with the service and state their coverage start.

Private service logs explain local proof refusals beyond the bounded caller labels.
Join `fleet.local_proof.refusal_context` to project-stage
`fleet.local_proof.diagnostic` records by server-generated `requestId`.
The context includes `operation` (fleet or project), a fixed route and method,
`connectionId`, and validated pane/bridge claims. Caller PID and process birth
come from kernel observations: `kernel_observed` is a refusal-time sample;
`previous_kernel_observation` includes its earlier observation time;
`unknown` means attribution was unavailable. An ancestry refusal uses
`failure_time_kernel_observation` with `claimantStatus` (`same`, `exited`,
`changed`, or `unavailable`), `failedChainIndex` (zero is the claimant),
`failedPid`, `ancestryPhase` and `ancestryErrno`. PID/birth identify the original
kernel claimant pin; only `same` confirms that lifetime is currently live.
The matching native event holds these facts in `ancestryFailure`. Claims and previous observations
never grant admission. Cold caller sampling is limited to one per connection,
12 new connections per minute and two concurrent reads. Healthy requests add
no attribution reads. Paths, argv, request bodies and credentials are excluded.
Project `pane_unavailable` now requires an actual native pane-not-found result;
other failures retain their specific observation stage in the private log.
Keep process and pane details in private evidence when publishing aggregate rates.

Native fleet projection timings also appear in the launcher's private service log
as `fleet.projection.timings` JSON events at info level. Each actual refresh logs
one completion/error record, with total `durationMs` and `phases` containing
`phase`, union wall-time `durationMs`, longest individual `maxCallMs`, and
`outcome`. Cached display reads do not start extra observations. Phases distinguish
settings/binding, census (including parent-edge reconciliation), local/PC/other
fleet reads, goals/status and their subagent/remote-goal/native-status awaits,
capabilities, waiting notices, activity, routing/catalog, Git and issue enrichment
(with separate issue-attribution and issue-keeper spans, plus local/remote process
proof, project membership and operator-head assignment spans). Capability display reads
use at most four concurrent fresh observations; returned seat order and waiting-notice
writes remain ordered. Delivery still revalidates its native proof.
Remote issue-attribution proofs use fresh groups of at most four panes. Each
first/last pass shares only that call's host binding, kernel and launcher reads;
per-pane native reads, occupant/birth/workspace/fleet checks and refusal remain
independent. Local and individual steering proofs keep their existing path.
No proof or census is reused between calls.
Nested and parallel phases overlap; do not add their durations. Outcomes describe
await completion, not proof of admission or a healthy native session. Records
contain no pane/session IDs, paths, commands, content or error messages.

The default local service log is `~/.local/state/clankie/clankie.log`;
`CLANKIE_STATE_HOME`, then `XDG_STATE_HOME`, override its state-home prefix.
Filter that log for `fleet.projection.timings` when comparing a roster window.

Remote proof diagnostics use `remote.proof.timings` for the caller's shell await
and `remote.observation.timings` for authenticated relay queue residence and
execution. The latter also includes the existing binding, pane-process, agent,
kernel-table, launcher, native-process, listener, ancestry and marker steps for
process proofs. Fields are fixed phase names, durations and outcomes only. These
are nested measurements: do not add shell, queue/execution and probe-step totals.
Telemetry never settles an observation or changes proof data or deadlines.
The Mac service generates the Windows relay bootstrap and sends it over the
existing SSH stream; a newly launched relay after deployment receives the timing
code. Existing older relays remain compatible and emit no telemetry.

### `metrics --issues [--issue ID] [--worker ID] [--since ISO] [--until ISO]`

Per-issue and per-worker measurements from the service's existing records,
through the operator-only `GET /v1/captain/issue-metrics` route. `--issue` or
`--worker` also selects this mode. Worker matches an exact label, terminal ID,
or retained native session reference. `--since` and `--until` are ISO timestamps;
the default window is the last 24 hours, with an exclusive end and a maximum
of 366 days. The window selects approval time for accepted episodes, or the
latest observation for unfinished episodes; totals cover the whole selected
episode. Turn-mode `--run` / `--limit` cannot be combined with issue mode.
Issue-only queries stream assignment records from exact retained bindings before
loading matching histories. Unrelated histories do not consume the 256 MiB full-read
budget; each source still has a 64 MiB limit. Unavailable or ambiguous sources
remain explicit coverage warnings.

```sh
clankie metrics --issue VUH-1608 --since 2026-10-04T00:00:00Z --until 2026-10-05T00:00:00Z
clankie metrics --issues --worker Noor
```

The JSON `report` contains `issues`, `workers`, `window`, and explicit `coverage`:

- `reportedTokens` sums provider-reported native worker responses, including
  cached input. Codex response IDs and Claude message IDs are deduplicated;
  cumulative Codex token-count events are not added again. Native child sessions
  and legacy/missing usage are not inferred. Unknown totals are `null`.
- `wallTimeMs` is elapsed time from the owner's assignment to an explicit
  approval in native user messages, including waits. The issue value is the
  envelope across its observed workers; worker totals can overlap.
- `fullCheckRuns` counts recognized worker `pnpm check` invocations in native
  tool command records (shell and literal Python subprocess forms). Lead batch
  checks and unrecognized wrappers are outside this partial count.
- `reviewRounds` counts explicit fix requests and approvals; `reworkRounds`
  counts fix requests. Native prompt wording is the evidence, not Linear's Done
  status. Unrecognized wording remains unknown.
- `leadReportedTokens` separately sums settled report-handling turns whose
  retained inbound acceptance names exactly one issue. Mixed/ambiguous inbound issue references
  are excluded; other work in a turn’s context is unknown. This is not all lead
  work on that issue.
- Worker `seatSettlements` and `unresolvedHireReceipt` expose ledger edges and
  pending receipts. A passed/ship edge is never issue acceptance; missing
  receipts do not establish historical delivery. Ledger edges match the preferred
  retained seat ID. Older seat aliases have no saved association intervals, so
  their ledger rows are excluded from that worker's settlement totals.

Retained exact local bindings come from conversation metadata, the persisted
hire-owner journal, and archived pane-tidy entries. This includes workers whose
conversation metadata predates `nativeSource` and panes that have been closed.
Matching session IDs and transcript paths are combined before counting, so the
same native history is counted once across these records. Retained labels, seat
IDs, session IDs, and transcript paths can select that worker with `--worker`.
These historical bindings provide attribution; they grant no current pane
control or delivery authority and cannot establish issue approval.

Missing, remote, malformed, conflicting, unreadable, or over-64-MiB sources
appear in `coverage.warnings`. Unbound session directories are not searched for
issue mentions. Separate files claiming the same native session are ambiguous
and excluded, including when `--worker` selects only one of their aliases. Reads also have
a 256-MiB total request budget, with skipped sources reported. There is no
fuzzy pane attribution or new metrics ledger. Known totals are partial when
other sources are unavailable. No transcript, command, tool output, or
credential appears in the response. This read neither launches checks nor
queries models. Include the report and its coverage in an issue handoff.

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
the same selected memories his own sessions do.

`--hook` reads Claude hook JSON on stdin. On `UserPromptSubmit` it prints the
whole card the first time a `session_id` asks, then only the notes that session
has not seen yet, under a short "Newer notes" header. Unchanged turns, and notes
that merely age out of the card, add nothing to the conversation. `SessionStart` prints nothing and re-arms
the session, so the prompt after startup, resume, `/clear`, or compaction
injects it again. Input without a usable `session_id` prints the card every
time.

Filtered by lane exactly as the session's own injection is: operator-private
notes reach only the operator lane. An empty store still returns a labeled
card. An unchanged hook turn can print nothing, which is not an error.

### `support [list | create read-state|shell --hours 1..72 --ref REFERENCE | revoke ID | offer ID]`

Manage a customer-issued support grant through the owner-authenticated body API.
`list` (the default) returns active and terminal grants. `create` requires a
support reference, defaults to 24 hours and accepts at most 72 hours. Read state
permits a support device to inspect conversation history and Clankie state;
it cannot change settings, send commands or read terminal output. Shell permits
commands and the content those commands can read during the grant window.

`offer ID` requires a Read state grant and returns a short-lived, read-only
pairing offer attached to it. The resulting device loses access on grant expiry
or revocation. Shell grants refuse pairing with
`support_pairing_requires_read_state` and authorize only the hosted Systems
Manager `StartSession` path. `revoke ID`
closes the grant. Responses are JSON. This command requires the operator
credential; a captain bearer cannot issue support access. `/support` exposes
the same command in the console. The hosted app and web account page provide
the customer controls without requiring a CLI.

### `telemetry ship --spool DIR --cursor FILE --log-group NAME [--audit-log-group NAME] [--once] [--interval SECONDS]`

Hosted infrastructure only. Ships a body's metadata telemetry spool (what
`CLANKIE_BODY_TELEMETRY_DIR` collects) to a CloudWatch Logs group, stream
`<tenantId>/<instanceId>`, each event at its own time. It must run on the EC2
host with instance metadata reachable, not inside the body: the tenant and
instance ids and the credentials come from the instance, never from the
spool. Every line is parsed against the event schema again before it leaves;
anything else is counted as `dropped`. The cursor file records how far each
spool file has shipped and advances only after CloudWatch accepts.

Support grants and accesses use the mandatory `support-audit/` child spool,
independent of diagnostic consent and diagnostic pruning. Hosted installations
pass `--audit-log-group clankie-obs-<stage>-audit`: each support record goes to
both the body and audit groups, with a separate acknowledgement cursor for
each destination. A failed destination retries without suppressing the other.
The host needs a writable mount for the support child directory so it can
remove completed prior-hour files after both groups accept them. Unacknowledged
support records remain; failed local audit persistence refuses support access.
If an outage exceeds CloudWatch's event-age limit, the log timestamp is the
ingestion time and the payload retains the original `atMs`.

`--interval` is 10–3600 seconds (default 60). Without `--once` it runs until
`SIGTERM`, printing `{"ok":true,"shipped":N,"dropped":N,"files":N}` per pass
and `{"ok":false,"error":…}` on stderr when a pass fails; a failed pass is
retried from the same cursor. See [hosted bodies](../infra/hosted/README.md#body-telemetry).

<a id="skill-setup"></a>

### `skills`

List the skills shipped with this body as JSON (`name` and `path`). Every skill
authored in `.agents/skills` ships and is always on; there is no selection to
change. `/skills` lists the same catalog in the console, and `clankie doctor`
includes it.

```bash
clankie skills
```

The shipped `tidy` skill exposes `/tidy` in the console. It starts an ordinary
visible, stoppable Clankie turn to inspect, harvest and close finished hired
panes with reasons. Output and saved reports remain in roster history, with a
five-minute reopen/resume Undo. Optional context can be passed as
`/tidy selection=w1:p1`. See [bundled skill declarations](bundled-skills.md#quick-action-declarations).

Existing service conversations discover added, changed or removed skill files and
workspace instructions before their next turn, keeping their history. Native
seats keep their harness's own resource-loading behavior.

Local Claude, Pi, Codex and Grok hires receive every shipped skill. Independent
global or project skills can still be discovered by Claude/Codex; owner-global
selection is untouched. See [how harnesses receive them](bundled-skills.md).

Local briefed Codex hires use a dedicated app-server with a native Codex TUI in
Herdr. Briefs and `message_seat` use protocol receipts; completion comes from turn
events. The owner can type into the same session, whose identity and transcript
stay visible. Existing unmanaged seats can use a supported native queue or
channel. Automated messages never fall back to terminal typing. A `steered`
receipt means guidance reached the active Codex turn, not an after-turn queue.

When a hired Codex seat asks through native `request_user_input` or
`request_user_input_async`, its question text, question IDs, and request ID reach
the hiring conversation as worker output. The roster summary shows
“Waiting on a question” and the request ID while it is pending. Async request IDs
are the tool's `call_id`, rather than an app-server request number.
The lead answers the existing prompt with `message_seat`, omitting `message`:

```json
{
  "seat": "term_worker",
  "questionAnswer": {
    "requestId": "observed-request-id",
    "answers": { "scope": { "answers": ["Change the core package only."] } }
  }
}
```

Use the observed request ID exactly (including its string or numeric type) and
answer every question ID. This uses the seat's native control channel without
interrupting the turn or typing into the terminal. Blocking sync questions hold
ordinary follow-up messages; native async questions remain nonblocking. The owner can still answer in
the pane. For sync questions, Codex takes the first answer and
`status: answered` requires the matching winning native tool-output record.
For async questions, Clankie sends the same attributed user-input envelope as
the Codex 0.160 TUI: it steers the active turn, or starts the reply turn if the
question's turn has already completed. Its receipt requires the exact native
user-message client ID and content. Async answers have no upstream atomic
first-answer arbitration; simultaneous owner and lead replies can both reach
Codex. Observed answered requests are refused, and an uncertain answer is never
sent twice. If no exact native receipt is visible, the result is `unconfirmed`;
inspect the session instead of resending. Approvals and folder-trust decisions
remain with the owner. Hand-started Codex panes without this controller do not
gain a prompt-answer channel.

If the confirming native snapshot also records another client answering the
same async question IDs, the result is `unconfirmed` with
`answered_concurrently_by_owner`. It cannot be reported as a clean answer.
Cold history reads do not re-notify unanswered async questions from older
completed turns; the latest completed question remains discoverable.

An interrupted or failed native turn releases its active-turn marker and stale
questions. If only an idle notification arrives, Clankie reads the native thread
to verify that the exact active turn ended before releasing dispatch. A late
completion from an older turn cannot release a newer one. Async questions
survive normal completion until they are answered.

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

Local OpenCode workers use `hire_agent` with `harness: "opencode"` on macOS
and the installed direct native executable, 1.18.18 or newer. A release whose
worker probe fails is refused with its version and the missing surface, before
any brief. Optional models use `provider/model`;
`effort` requires an explicit model and a variant it supports. Account, skill,
Chrome and extra-argv overrides are unavailable. The same native TUI stays in
Herdr; its original process/socket, cwd and displayed session are checked before
SDKv2 delivery. Owner questions and permissions hold sends. Native queue
acceptance does not prove attention or completion, and uncertain delivery is
never retried.

Registered dedicated worker SQLite history supports `clankie agents list` and
`clankie agents read`. `clankie agents resume … --conversation ID` needs the same
live controller and hiring conversation; saved metadata cannot start another
process. Remote control, general profile discovery, restart reattachment and
new-process resume remain unavailable. Exact-session interrupt is supported.
`close_seat` asks an owned live worker's original TUI to exit and succeeds only
after its terminal disappears. Cold, replaced or switched sessions refuse;
there is no unconditional physical pane-close fallback. See the
[worker checkpoint and live limits](testing/2026-10-04-opencode-workers/README.md).

Linked Mac POSIX OpenCode hires use `harness: "opencode"` and the configured fleet
ID. Their original native controller is carried over private loopback SSH with
fresh remote process/socket/Herdr proofs, no local fallback and no automatic
reconnection. `clankie agents list --host FLEET` and `clankie agents read FLEET:ses_…`
read only registered dedicated worker SQLite history. Resume uses the original
live controller on that exact SSH target. The remote Mac needs Node 24+, Python
3, Herdr, native OpenCode 1.18.18 or newer that passes the same probe, and its
existing Clankie fleet link. Windows is unsupported. Remote live acceptance remains open; [fixture evidence and limits](testing/2026-10-05-remote-opencode/README.md).

Every hire logs its selected lane and reason. The result carries `control.mode`:
`channel` for the Claude worker channel, `adapter` for Codex or OpenCode,
`terminal` for an unbriefed native launch, or `unavailable` with `control.reason`
explaining missing structured control. Registered remote fleets do not change the control lane of a
local hire. Native questions remain visible in the pane; approvals and
folder-trust prompts remain owner decisions.

Fresh Claude hires write the brief once to a private, exclusively created JSON
file in session state (directory `0700`, file `0600` locally). A short native CLI
startup prompt references it with `@file`, so Claude expands it after startup.
JSON keeps admitted brief characters and line breaks out of Herdr’s shell
arguments and Claude’s binary-file/line limits. The existing 32 KiB/no-NUL hire
validation remains. The service appends multi-line working preferences even
when the lead provides a plain single-line brief. Settings are also file-backed;
inline system/append prompts and JSON settings/agent/MCP config arguments use
their native file forms. Remaining control-bearing arguments fail before launch. The file remains available for
inspection of an uncertain start. They do not also send the brief over the channel. Resumed hires and follow-ups use the channel; its stdout ACK alone
does not establish native prompt acceptance. A confirmed fresh Claude brief requires the complete decoded JSON file attachment
in that exact session’s active native transcript; a file-reference prompt alone,
partial attachment or changed contents cannot confirm it. Herdr's `agent start`
readiness wait ends only when the agent is idle, so a fresh brief whose first
turn outlasts it times out the launcher after launch. That one typed timeout
still confirms from the transcript attachment; any other launcher error leaves
the start unconfirmed (VUH-2802). Resumed briefs require
the complete channel prompt. Slow or unavailable
transcripts leave delivery uncertain, retaining the original receipt: inspection
can reconcile a late prompt without sending it again. Claude records a channel
follow-up that arrives mid-turn only when it absorbs it at its next pause
between steps, often minutes later. A follow-up the bridge acknowledged exactly,
to a seat still working (or blocked) whose session already took a channel event,
therefore reports `delivered`, `state: queued` and `status: queued_until_turn_end`
instead of uncertain; it is not proof Claude read it. An idle seat, or a session
with no channel event yet, still needs the transcript entry (VUH-2779).
Messages to one seat go out one at a time: a lead's or peer's message that
arrives while another delivery to that seat is in flight waits its turn (up to
25 seconds) instead of being refused, and one that still loses the seat is a
definite `undelivered`, never `uncertain`.

The hire records its observed session and hiring conversation before waiting
for channel readiness or the first-prompt receipt. A failed startup retains that
ownership and a durable failure summary in the roster, and alerts the hiring
conversation through the existing worker-watch wake path. An allocation without
a native session retains its pending hiring claim and failure flag; it grants
no native control. Startup flags clear when the original hire reconciles.

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
existing app-server connection. On Windows, control supports an existing
dedicated loopback backend and a TUI attached with `--remote`, preserving their
private environment, cwd, configuration and MCP bridge. This adapter does not
establish automatic supervision of new Windows launches; that launcher path
still needs native verification. Existing embedded `--no-daemon` sessions and explicit named profiles
retain that launch mode. Steering refuses when no private endpoint can be proven.
An embedded TUI may queue through the existing SSH CLI only when fresh kernel
observations prove that its home is the SSH account's canonical default `~/.codex`
and the CLI inherits that same home. The native projection must positively prove
a standalone TUI; an absent or rejected remote endpoint is insufficient.
The pane/session and home proof are repeated after preparation. Caller authority
is checked in full before the final observation and again after it, with a
250 ms deadline immediately before sending. A full check that reads a linked
machine takes seconds, so a check may split in two: its remote part (such as the
sender's process proof) is read again alongside the final observation, and only
its synchronous in-memory recheck (link, fleet revision and settings
generation) runs at the gate. Each final proof is stamped as it completes, and
the write must follow the older one within 250 ms; waiting on the slower proof
never restarts that clock. When they finish too far apart, both are read again,
the faster one started later so they complete together, up to three times;
otherwise nothing is sent. A check without the split runs in full under the same
deadline. A timeout reports undelivered and never sends on late approval
(VUH-2779). Private, changed
or unproved homes refuse the fallback; a private native receipt cannot authorize
a second send through CLI. A Windows queue command line above 30,000 escaped
characters, or a PC Claude channel body above 16,384 characters, stages the exact
UTF-8 body on the PC under
`%USERPROFILE%\.clankie\seat-messages\<uuid>.md`, verifies its SHA-256 and queues a
short pointer. The channel keeps the original full-body receipt fingerprint;
its native transcript confirms the pointer. Other seat events retain their
existing clipping notice when they exceed the channel contract. The receiver reads and verifies the body, then deletes that file.
Staging failures, authority refusals and proven pre-launch failures attempt
immediate deletion of that send's generated file. Accepted and uncertain pointers
retain their files for consumption; files older than seven days are pruned on a
later staging write. A cleanup failure preserves the original delivery result.
Clankie checks the current pane/session, native process lifetimes and ancestry,
private-home consistency, listener and actual connected TCP owner before steering
through the fleet's native SSH forwarding. Private queues reach the same proven
backend and remain pending until its active turn settles, preserving custom
`CODEX_HOME` sessions. These observations do not widen tool grants.
`state: steered` confirms the exact active turn;
`state: queued` and `status: queued_until_turn_end` mean native queue acceptance,
not that the agent saw the message. A goal may hold it until the whole goal ends.
No new setting or daemon is enabled. An unavailable connection does not promise an automatic
retry. The current Codex adapter's control map is in memory, so a saved session
reference alone does not reattach after a service restart. Sends target the bound
Codex thread even if the owner switches the TUI to another thread; they do not
follow terminal focus. Explicit owner terminal
control remains available; normal agent messages do not use it. See
[ADR 0207](adr/0207-work-records-and-native-agent-delivery.md).

<a id="captain-seat-control"></a>

### `seat show | set app|claude|codex --revision REV | start --revision REV --request UUID | status UUID`

Choose where the next explicit launch opens Clankie on this Mac: the app,
Claude Code or Codex. This choice is independent of `fleet hire` worker
preferences. Reading or saving it does not move an existing conversation or
restart a seat. It is available on a self-hosted Mac only.

`seat show` returns `{schemaVersion:1, revision, seat, supported}`. Use that
revision with `seat set`; a stale revision is refused. To open the saved choice,
make a UUID, retain it, and pass it with the current revision to `seat start`.
Poll `seat status UUID` after a lost reply; if no record exists, sending the
same original start request is safe. Never make another UUID automatically to
compensate for a timeout or an `uncertain` result.

Each start creates a separate workspace conversation. App starts require a
ready service model. Terminal starts create a new Herdr tab with the native
`clankie claude|codex --conversation ID` initial command. They preserve the
existing native sign-ins, plugins and account rules; no automated terminal
input or existing-pane target is accepted. A new tab receives focus.

Results carry `requestId`, `seat`, `outcome`, and, when known, `conversationId`
and `paneId`. `starting` means the launch is pending or the native bridge is
still connecting; a created pane alone is not `ready`. `ready` establishes the
requested native harness bridge, or the app conversation after model readiness.
`failed` is a definite pre-launch failure (`not_ready`, `unavailable`,
`authority_revoked`, or `selection_changed`). `uncertain` with
`launch_unconfirmed` means a pane may have opened; reconcile the original UUID.
A bridge that later connects can turn its original uncertain result into ready.
An unbound start becomes uncertain after two minutes. Settled results are the
outcome of that start, not a live seat-health display.

HTTP is the same contract: `GET`/`POST /v1/captain/seat`,
`POST /v1/captain/seat/start` with `{expectedRevision, requestId}`, and
`POST /v1/captain/seat/status` with `{requestId}`. Only the owner operator or a
current Take Control device can use them, including through the paired-device
relay. Saving takes `{expectedRevision, seat}`. Requests cannot choose a linked
machine, command, account path or existing pane. The node-free schemas live in
`@clankie/protocol/captain-seat` ([ADR 0292](adr/0292-onboarding-opens-an-explicit-local-seat.md)).

<a id="seat-commands"></a>

### `claude[N] | codex[N] | opencode [--resume [SESSION_ID --conversation ID [--from-config-dir PATH]]] [--conversation ID | --new] [--plugin-dir PATH] [--mcp-servers NAME,...|none] [--dry-run]`

Open Clankie in the selected native harness ([ADR 0152](adr/0152-a-harness-takes-the-operator-seat.md)).
`clankie claude` opens this seat with `claude`; `clankie claude2` uses your
`claude2` account command. Numbered Claude commands are resolved through your interactive
`$SHELL`, including shell aliases and functions. The same seat flags work with
either command. Each numbered command keeps its own resume record. `clankie codex` and `clankie opencode` open the corresponding native harness with the same flags.
`clankie grok` and `clankie prime` take them without `--plugin-dir`; see
[Grok Build](#grok-build-worker-and-operator-seats) and [Prime Agent](#prime-agent-operator-seat).

`clankie codex2` selects the registered account labelled exactly `codex2`:
`clankie accounts codex add /absolute/CODEX_HOME --label codex2` registers it.
The number is part of the label, never an account-list position. Unknown labels
fail without selecting another account. The launcher captures the canonical home
for native discovery, the app-server and TUI. Numbered commands keep separate
resume records and refuse to resume after their label is rebound to another home.
Plain `clankie codex` retains the current `CODEX_HOME` behavior. OpenCode has no
numbered account command.
For numbered accounts, set `CODEX_HOME` to that registered home in the environment
of native plugin installation commands and the Codex session used to review
`/plugins` and `/hooks`. Setup under a different home does not prepare this account.

Claude launches need a TTY and the selected Claude command available. The launcher projects the bundled plugin
(or `--plugin-dir` source) into a private launch directory with only the selected
skills. Identity, hooks, and MCP are retained. It passes the permission allowlist
for `clankie` commands, disables an older installed `clankie@clankie` for this
session, and enables `clankie@inline`. Its explicit MCP bridge uses the
`server:clankie` development channel. This also prevents a stale marketplace copy from restoring pruned
or disabled skills. Keep any marketplace seat plugin disabled globally, since
its forced output style makes every session answer as him when enabled there.
When the seat holds the global chat, inside the service's herdr fleet it names
that pane `clankie` once Claude Code
is detected there, which binds the pane to his own persona rather than a fleet
contact; a second pane claiming the name stays an ordinary fleet agent and is
told so on stderr. The pane is un-named again when the session ends.

Claude seats use [`--strict-mcp-config --mcp-config`](https://code.claude.com/docs/en/cli-reference)
with a private `seat-mcp.json` in the launch projection. Only the selected Clankie
plugin's MCP declarations load by default: `lead` becomes `clankie`, other
servers become `clankie-NAME`. The session also sets
[`disableClaudeAiConnectors: true`](https://code.claude.com/docs/en/mcp#disable-claudeai-connectors).
Owner user/local servers, workspace `.mcp.json` servers and other plugins' MCP
servers are omitted. The owner's files stay untouched; plain `claude` keeps its
MCP configuration. Identity, hooks, agents, skills and the bridge's channel remain.

`--mcp-servers NAME,...` (Claude only) opts configured servers into this launch;
`none` is the default. For example, `clankie claude --mcp-servers blender,pixel-mcp`.
Names resolve from the selected Claude profile's `.claude.json` and workspace
`.mcp.json`, with local > project > user precedence. Unknown names, Clankie's
reserved names and personal Linear connectors are refused. With a numbered
account alias, set `CLAUDE_CONFIG_DIR` to its profile to resolve opt-ins there.
Repeat the flag on `--resume`; the allowlist is not saved in the resume record.
Definitions are copied into a file readable only by the owner; `--dry-run` shows
its path without printing server credentials. The generated bridge requires the
launcher's `CLANKIE_CONVERSATION_ID`; reusing the file with that binding absent
fails before connecting. Its tools use `mcp__clankie__*`; the plugin still supplies
identity, hooks, room-agent permissions and skills. Conversation-scoped operator
MCP and event poll/read/ack/reply require an explicit conversation and a
kernel-verified launcher binding; an unbound bridge never inherits `global-default`.
An operator-bearer HTTP MCP session that omits the conversation has no conversation
at all: stateless tools remain available, including the ordinary `clankie linear`
read/graphql/post/catalog paths, while lead tools refuse with
`conversation_binding_required`. Naming a conversation still requires native
launch admission; a bearer cannot select it by text alone. The launcher
registers its direct harness child plus a nonce hash at
`PUT /v1/captain/seat-bindings`. Only the intended bridge receives the nonce
through private MCP configuration (Codex/OpenCode use a 0600 nonce file), not
the inherited harness environment or argv. `clankie doctor` reads helper
availability and the last typed refusal/recovery from
`GET /v1/captain/seat-bindings`; this read does not prove a live model harness.
Prime lacks a verified kernel PID/launch edge and remains refused. Real harness
wrapper compatibility remains unproven; process chains, precise refusals,
joined/relay exclusions and consumed-report recovery are in the
[seat binding reference](../integrations/claude-plugin/README.md#binding-and-the-known-unbound-bridge-gap).
No owner MCP files are written.

VUH-2888 uses two releases. This preparation release sets
`apps/clankie/operator-seat-policy.json` to `observe`: the same native checks
run and report refusals, while admission keeps the old runtime's behavior.
`clankie doctor --json` includes the mode and a fresh local launcher inventory,
with bound/unbound status and exact recovery. Observe mode retains the
existing doctor readiness headline; binding diagnostics follow it. An active
enforcing update, or the latest update refused for `operator-seats-unready`,
promotes the inventory/unbound problem to the headline even while the running
service remains in observe mode. This is read-only target-policy evidence from
the updater receipt; enforcement always uses the target artifact's policy.
Observe mode retains the
pre-existing stray-process gap. A later enforcing artifact changes the policy
to `enforce`; the preparation release's updater refuses it before stopping
services if any live launcher/bridge is unbound or the inventory is incomplete.
It checks binding recovery again before declaring the update healthy; failure
rolls back to the preparation release. Do not skip that preparation deployment.

For a legacy Claude seat, reconcile original hire/message receipts by their
original IDs; never replay them. From another operator shell run
`clankie seat migrate prepare --conversation ID [--request UUID]`. This records
the authoritative native session/profile/cwd and old process lifetimes, and
durably pauses that conversation's execution. Other conversations keep running.
The response and doctor retain the migration ID.
`clankie seat migrate status UUID` only inspects the original. An unsettled turn
or delivery, missing transcript/profile, ambiguous launcher or unresolved receipt
holds migration. Exit only that original native session. Use doctor's exact
`CLAUDE_CONFIG_DIR` and
`clankie claude --resume SESSION --conversation ID --migration UUID` recovery.
The launcher proves all recorded old processes exited and claims this launch
once before spawning. A lost or failed claimed launch remains held: inspect it,
never repeat it or select another session. Trust/hook prompts require the
owner's ordinary action. After that same session/profile/cwd is bound and ready,
`clankie seat migrate complete UUID` releases its hold. Other harnesses whose
exact profile/session recovery cannot be proved remain held for explicit recovery.
If a claimed launcher definitively failed before spawning, the journal remains
`resuming`. After proving that no successor exists, start the same doctor's
session/profile/cwd/conversation command without `--migration`, then run
`complete UUID` once it is bound and ready. Do not claim again. An uncertain
spawn or occupied conversation stays held; do not start a second process.

Every fresh Claude launch starts a new Claude Code session under a recorded id.
Without a selection it takes the shared global chat (`global-default`) while no
live seat holds it: `GET /v1/captain/seat-context` reports `occupied` while a
seat's channel is polling that chat. If one does, or with `--new`, the launch
creates a separate workspace chat through `POST /v1/captain/seat-context`, rooted
at the launch directory, with its own transcript, tool context and wake channel.
Two launches started within seconds of each other can both find the global chat
free, because a seat holds it only once its channel starts polling; use `--new`
for the second. Every chat is available in the app and `clankie conversations list`.
A running home service and, for a home-machine seat, an operator credential are required, including for
`--dry-run` without `--new`; failure to resolve or create the chat stops the launch.
Joined installs use their brokered join registration instead; see [`join`](#join)
for their folder-bound Claude seat behavior and current limits.
`--resume` reopens the last seat for that Claude command and its chat. The
conversation selection is retained on resume, and a different `--conversation` is refused.
`clankie claude --resume SESSION_ID --conversation ID` reattaches one exact Claude
session to its conversation with the seat identity set, the way a fresh launch sets
it. The session must be in this launch's config home (`CLAUDE_CONFIG_DIR`, else
`~/.claude`). With `--from-config-dir PATH` the launcher copies its transcript in
from that config home first, never moving or overwriting a transcript. It opens in
the session's own working directory. The launch is refused if the session belongs
to another conversation or was retired by a reset, or if the conversation already
has a live seat. Close the old seat's pane first. The session becomes that
command's resumable seat. `--dry-run` checks everything and copies nothing.
Skill selection is reapplied at launch, but resumed history can still contain previously loaded guidance.
`--conversation ID` selects an existing global/workspace service conversation or
Discord text/voice room, resolves its cwd through `/v1/captain/seat-context`, and
opens the selected harness there. That
workspace must exist on the native host. The prompt includes its agent
instructions and the owner's persona/fleet preferences. The MCP bank and channel
share its conversation. Inherited worker capabilities and conversation
selections do not select the seat. `--conversation global-default` selects the
shared global chat even while another seat holds it. Workspace seats do not rename
themselves as the global Herdr head.

While its channel is live, the seat receives that conversation's worker reports,
escalations, wakes and watches instead of starting a service model turn. Closing
the seat returns new inputs to the service runner. A turn already accepted by
either destination keeps that destination; uncertain native delivery is never
replayed automatically. Internal self-wakes, watch notifications
and worker messages run on the service lane whenever no seat is live, whichever
harness last held it; only signed Linear activity still waits for the attached
receiver. The service lane is a bounded view of the conversation log: after a
harness has driven the chat it starts a fresh Pi session seeded from the recent
log (the older session file stays on disk). When the seat polls again, it first
receives one `service-handoff` turn with the service's actual turns since its
last synced turn — never the original inputs again — and a fresh harness session
gets the same projection at SessionStart (`clankie prompt --sections conversation`).
An uncertain handoff is never resent; the chat records that it may not have
arrived. See [ADR 0218](adr/0218-native-seats-drive-their-attached-conversation.md#the-log-is-the-conversation-2026-10-06).
Failed self-wakes remain scheduled and
retry after 5 seconds, then 10 seconds; after three failed attempts, or at once
when the model provider rejected Clankie's credentials, the wake is held rather
than retried. A held wake gets one more attempt when the chat's seat next polls
(the wake then goes to the seat), and runs again after a service restart. The log
shows a retried wake's prompt once. Each chat has its own retry state, and a
replacement wake starts fresh.
`/autonomy clear` cancels the selected chat's scheduled wake; it does not cancel
an already running turn. Worker reports retain their original delivery IDs and
require explicit read acknowledgment after delivery.
`/auto on` requires the owner/device credential; the shared captain bearer
receives HTTP 403 `goal_owner_required`. The console uses its owner transport,
and headless owners use `clankie auto on`; status, `off` and `/autonomy clear`
use the captain transport. This raises the activation bar, but a same-UID shell
can still read Keychain credentials or the device signing key; it does not
provide OS-level owner isolation. Service goals (ADR 0130) were retired by
[ADR 0264](adr/0264-projects-on-auto-replace-goals.md): projects on Auto carry
standing work, and `schedule_wake` carries long work between rounds.
Stalled service preparation releases its admission so the attached seat can take
later queued inputs. Native delivery keeps its existing acknowledgment deadlines
and ten-minute escalation reply wait; it has no new five-minute reply cutoff.
Selecting `global-default` affects only that chat. To drive a Discord room,
select its conversation; replies return through the original room delivery and
authority checks. Rooms remain read-only to ordinary `send` and `reset` commands.
Room attachment adds no machine grants: its cached MCP bank has social tools and
no generic operator body identity. It cannot inherit an actor's grants from a
later room message. See [ADR 0218](adr/0218-native-seats-drive-their-attached-conversation.md).

`--dry-run` prints the launch plan without creating a chat or launching:

```json
{
  "ok": true,
  "command": "claude",
  "args": [
    "--strict-mcp-config",
    "--mcp-config",
    "…/skill-projections/launch-…/seat-mcp.json",
    "--name",
    "Clankie",
    "--settings",
    "{…}",
    "--plugin-dir",
    "…/skill-projections/launch-…",
    "--dangerously-load-development-channels",
    "server:clankie",
    "--session-id",
    "…",
    "--permission-mode",
    "auto"
  ],
  "plugin": { "source": "plugin-dir", "path": "…/skill-projections/launch-…" },
  "channel": true,
  "sessionId": "…",
  "resumed": false,
  "cwd": "/Users/me/dev/project",
  "maximumTrustMode": false,
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

`clankie codex` opens the real Codex TUI on its own app-server thread.
Install the [Codex seat plugin](../integrations/codex-plugin/README.md) first.
The launch plan includes a typed `hook_trust_required` owner step: review the
plugin in Codex's `/hooks`, then exit and launch the seat again. The launcher never
bypasses hook trust. Wakes bind only after trusted session hooks succeed.
`--resume` retains the last Codex thread and conversation independently of the
Claude seat. Fresh Codex launches choose their chat the same way.
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

Before reading the bearer from the broker it checks its parent process: only a
native harness (`claude`, `codex`, `opencode`, `grok`, or their Node entry
points) may open the lane. Started from an agent's shell or script it exits 1,
because missing worker tools never authorize Clankie's own lane; the worker
uses its granted `clankie_tools`/`clankie_call` or tells him with
`message_clankie`. An explicit `CLANKIE_OPERATOR_TOKEN` (the Grok and Prime Agent
seats and verification scripts) skips the check, as does a parent `ps` cannot observe.
This stops a well-behaved agent from escalating; it is not a security boundary
against a process that can already read the owner's Keychain.

It is also his channel. While it runs it long-polls `/v1/seat/events` and
pushes worker reports, self-wakes, herdr completion watches and room escalations into the
session as `<channel source="clankie" kind="turn|message|wake|watch|escalation"
conversation="…" event_id="…">`; that polling is what binds the seat as his
head, and with no bridge polling the same turns run the pi operator lane. A
host-authenticated owner send from the app or another operator surface to a
seat-held global/workspace conversation arrives as `kind="turn"`: answer
normally in the same synced conversation, without a
`reply` tool call. Its `owner_kind`, `owner_id` and `surface_client_id` metadata
retain the verified principal and caller-reported surface; the surface name
alone grants no authority. The conversation journal records the same
`ownerOrigin`. Owner authority is rechecked before native admission. A
`reply` tool answers an escalation by `event_id`; the reply lands in the
escalating conversation as his own message. To speak in a Discord room on his
own initiative, the seat calls `room_turn` with the room conversation ID (or a
Discord `channel` ID for a room he has no conversation in yet) and a brief,
plus optionally `replyTo` (a message ID) and `file` (a path inside the
operator conversation's working directory, by default the service's home
folder). It forks a one-shot room turn under that room's grants and mouth. The turn sees the room's recent history and the brief, never the seat's
transcript. It returns what posted, its message ID, or why not, and the action
is recorded in both conversations. An identical request, or a reused
`requestId`, returns the first result without running again (ADR 0218,
2026-10-06). Claude Code loads the channel
only when `clankie claude` passes its development flag; without it the tools
still work without consuming events, leaving those turns with the service.

The bridge keeps polling through acknowledgment errors, retaining exact receipt
IDs for reconciliation without repeating channel notifications. Content-free
pump diagnostics live in the state home's `clankie/seat-bridges/<pid>.jsonl`
(`~/.local/state/clankie/seat-bridges/` by default): PID, conversation, source
hash captured at module load, stage and event ID. A failed request adds
`elapsedMs`, the error name and code, the system `causeCode` (`ECONNREFUSED`
while the service is down) and the service's `httpStatus` (503 while it shuts
down); a poll that fails with `TimeoutError` near 35 seconds was parked by the
service, not refused. A seat that polled the previous service within two
minutes of a restart keeps its conversation for 45 seconds after the new
service starts, so wakes and reports wait for it to reconnect instead of
running on pi beside it; the evidence is
`~/.clankie/captain/delivery-receipts/head/<conversation>.json.presence`.
A live tool connection alone
does not prove a running receiver. A failed channel write remains uncertain;
the bridge stops polling rather than implicitly acknowledging an unseen take.
The service keeps every event inside the channel's 16,384-character limit: a
service handoff projects at most that much, and any longer event is clipped
with a note saying how many characters did not reach the seat.
An installed update affects newly loaded bridges; recovery of an existing
stopped receiver must preserve its original harness session and delivery fences.

Worker `message_clankie` reports project as `kind="message"`, framed as
untrusted agent output, never an owner instruction. A report without
`urgent: true` that is bound for an idle native lead seat waits for that seat's
next round: the seat's next turn, any other delivery to its conversation, or at
most ten minutes. Many reports then cost the seat one turn instead of one turn
each (VUH-2274). An urgent report, an owner turn or a lead message from another
conversation is delivered at once and brings the waiting reports with it. A
waiting report stays `stored`; restarts deliver it in the next round. A
completion watch whose worker finished cleanly (its turn completed, or the pane
settled `done` or `idle`) joins the same round before it is accepted, so the
watch stays durable while it waits. A gone pane, an unverified or failed turn,
or a pane waiting on input wakes the lead at once. Completion harvests remain
`kind="watch"`, and self-wakes remain `kind="wake"`. These tags do not change
the service-owned lead route or delivery receipts. A room-owned worker message
still uses `reply` with its `event_id` for the correlated room reply; the original
actor, route and mouth checks remain in force.

### `mcp --seat`

For connected-account tools in a worker, use `mcp --grant FILE` instead; see below.

A fleet pane's stdio mailbox channel: no tools, only the channel. A message to
that agent (a DM from the app, or a group-chat turn) arrives as
`<channel source="clankie" kind="message" conversation="…" event_id="…">`
instead of being typed into the pane. Identity is `HERDR_PANE_ID`. On a local
machine the `clankie-worker` Claude plugin's `worker` server runs this command,
handing it Claude's argv, and it polls only when that session approved
`plugin:clankie-worker@clankie` through `--channels`. Hires and hand-started
panes use that plugin channel.

Registering `clankie-seat` yourself (`claude mcp add -s user clankie-seat --
clankie mcp --seat`, then starting Claude with
`--dangerously-load-development-channels server:clankie-seat`) is a legacy,
manual bridge: no hire path registers it, and `--channels server:clankie-seat`
is rejected as not on the approved allowlist. Without a matching channel in the
parent argv the bridge serves an empty channel and does not bind, so a
user-scoped registration never consumes mail beside the selected worker plugin.

<a id="mcp-fleet-fleet-connected-tools"></a>

### `mcp --fleet`: fleet tools and native worker messages

Register `clankie mcp --fleet` in Codex with `env_vars = ["HERDR_PANE_ID",
"HERDR_SOCKET_PATH"]`, or install the `clankie-worker@clankie` Claude plugin.
Preserve generated/symlinked harness configuration: inspect
`doctor.harnessBridges.codex.configSource` and edit its owning source.
Codex seats Clankie hires into a dedicated app-server run the bridge this command
spawns, `node INSTALL/integrations/claude-plugin/worker/bin/fleet-mcp.mjs`,
directly, so no wrapper CLI process stays resident for each one (VUH-2390).

Admitted fleet panes receive every connected MCP tool whose account is verified,
except persona-bound Linear worker-publishing tools. Admission uses the pinned
local Herdr socket, a live remote relay stream, or a remote fleet link bearer.
A bearer proves only its fleet, with no verified pane or mailbox authority.
No project grant, native session or workspace proof is needed for these tools.
Projects retain roles, caps, hiring and tracker binding.

The connected-tool service lists `clankie_tools` and `clankie_call`; the shared
worker bridge adds `message_clankie`, `message_clankie_status`, and, for a proven native sender while peer
messages are on, `list_fleet_seats` and `message_peer`. Search connected tools
with `{query}` for at most 20 names/descriptions,
or `{names}` for up to 10 input schemas, then call with `{name, arguments}`.

Connected calls retain a `receiptId` when an HTTP reply is lost. The existing
`clankie_call({receiptId})` reads the original result without dispatching again.
When a tracker provider settles a refusal of a read (an unknown issue, say), the
call returns `outcome: "ok"` with `isError: true` and the provider's message, and
its receipt holds that answer (LOCAL-VUH-34). A lost, failed or timed-out
provider call stays `uncertain`, and so does any write.
A native seat can also inspect any of its own receipts and abandon one that is
a proven READ (LOCAL-VUH-13). The commands exist for every receipt; whether a
particular original is eligible is decided only from what its receipt retained.

```sh
clankie agents call-receipt inspect ORIGINAL_UUID [--abandonment-id UUID]
clankie agents call-receipt abandon-read ORIGINAL_UUID --reason TEXT
```

These commands use the calling native seat's linked fleet authorization. They
require the original native authority, current account and original route;
they do not fall back to an operator credential. UUIDs and per-action flags are
validated before HTTP; abandonment needs a nonblank reason of at most 500
characters. The connected-tool equivalents are
`clankie_call({receiptId, action: "inspect", abandonmentId?})` and
`clankie_call({receiptId, action: "abandon-read", reason})`.

Only an original with a retained `builtin-strict-no-effect/v1` READ snapshot can
be abandoned. The built-in tracker emits the snapshot under its store lock, before
the read runs and before any effect, binding the store directory incarnation and
store ID. The host adds the account binding, argument fingerprint and original
selectors to it, and the receipt also retains the original native session
(occupant, shell and harness process lifetimes). The audited built-in branches are
`get_user`, `get_issue`, and `list_runs` without a host runner, using the default
clock. The service's own tracker has a runner, so its `list_runs` stays UNKNOWN.
Initialization, cycle rollover, custom clocks, callbacks without a purity
contract, selectors over 1 KiB, changed routes or store incarnations, writes,
repository-routed calls and remote providers cannot supply that proof. A
read-looking name or caller-supplied classification never makes an original
eligible. Reads that can't retain a proof (manual grants, selectors over 1 KiB)
skip the native census and READ fences and stay ordinary unclassified reads. So
does a read whose READ fence can't be established: it isn't refused. The route a
READ was proved on is fenced again at commit. That covers the hire's project, the
repo registry, conventions and other repos' stores, so a route change after the
pre-lock check refuses the read or recovery before it runs. If a backend read throws after its snapshot (a mistyped key, say), the
receipt settles as a definite `confirmed-error`.

Inspection never replays the call. For any retained receipt it reports
`classification` (`READ` or `UNKNOWN`), `recovery` (`abandonable` and, when false,
its `reason`), `original` (server, tool, fingerprint, account binding, native
session, READ snapshot), `execution` (`dispatchAdmission`, and `response`:
`confirmed-success`, `confirmed-error`, `settled-body-unavailable` once an old
body was trimmed, or `UNKNOWN`) and `abandonment` (`recorded` with the audit, or
`not-observed`) as separate facts. An abandonable original is reinspected under
its store lock with the same native session; another session, a changed route,
account or store, revoked admission or fleet tools off are refused. A READ whose
native session was not retained is still `READ` but not abandonable.

Abandonment records a decision to stop waiting; it does not cancel execution or
authorize repeating the original. One decision is kept per original: the same
`abandonmentId` answers the recorded audit, and a different one is refused with
`abandonment_conflict`. Inspecting with a different ID reports the recorded
decision and `requested.recorded: false`. Abandoning a settled READ is allowed and
only records the decision. A late original result settles into the same receipt
without erasing its audit. Unproven originals are refused with
`original_read_unproven` (or `original_session_unproven` for a READ without its
session) and record nothing. The bridge mints one reserved `abandonmentId` before
sending abandonment. If its reply is uncertain, preserve both `receiptId` and
`abandonmentId` and use `inspect` with those IDs. Never resend abandonment or the
original call.

The receipt journal keeps result bodies for the newest 1,000 settled calls;
older settled READs also drop their recovery proof (`proofRetention: "trimmed"`)
unless they hold an abandonment audit. They are still reported as `READ`, but they
can't be abandoned (`original_read_unproven`). Uncertain receipts keep their proof.
Receipts trimmed before LOCAL-VUH-35 lost their classification and read `UNKNOWN`.

Receipts written before this contract retained no classification, so they can
never qualify. The historical LOCAL-VUH-13 originals
`70136c4f-43ad-45f3-8434-5de9fd04545a` (`get_issue`) and
`7065c6aa-fffb-4e55-9c0f-550d139af96c` (`list_runs`) remain UNKNOWN and blocked.
No lookup, polling, settlement, abandonment or replay of either original is
authorized; the work they belonged to proceeds with new calls under new receipts.

`message_clankie` reports to the conversation that hired the worker. A
host-admitted `message_seat` from another conversation delivers and names its
`ownerConversationId`, but the hire keeps its lead, so its reports and
completion watches stay there. Only a hire whose lead conversation is gone, or
a hand-started seat, is adopted by the conversation that messages it. The worker does not
choose the destination. Worker reports fall back to `global-default` when that
conversation has been removed; a retained room with revoked grants is refused.
Local and fleet-qualified remote workers follow the same persisted ownership
proof and delivery receipts.
Keep the original `message_clankie` receipt's `deliveryId`. The read-only
`message_clankie_status` tool (Claude and Codex), or
`clankie agents message-status DELIVERY_ID` in the sending native pane, returns
`{schemaVersion: 1, deliveryId, deliveryStage}`. The service verifies the sending
pane and its original native binding, so replacement seats cannot read old
receipts. The API is `GET /v1/fleet/seats/{paneId}/messages/{id}/status`.
It reads durable ADR 0211 progress (`stored`, `delivered`, `consumed`, `responded`
and stop stages such as `expired`), without resending, acknowledging a report,
or reconciling a send fence. Check it before retrying or starting dependent work.
Consumption does not prove task completion. Unknown receipts return 404 and do
not prove nothing was sent; preserve and reconcile an uncertain original with
`message_clankie`. A report stays retained until its lead reads it, then for
24 hours; after that its status reads as unknown or `uncertain`, never
`not_sent` (VUH-2410).

When an uncertain original is reconciled to `stored`, the worker retains a
five-minute matching window keyed by its native binding and normalized text.
An exact resend in that window returns the original receipt without a POST,
including across a bridge restart. A different follow-up used to reconcile the
original stays unsent; the refusal says to call again with the distinct follow-up,
not to resend the original. Starting fresh distinct intent closes the window.
After expiry, identical text can be a deliberate new status report; an ordinary
successful send does not open a window. This does not expire unresolved claims.
The small private matching record is separate from the exclusive claim in
`~/.clankie/inbound-receipts`; never delete either to bypass uncertainty.

Worker output remains in the owning conversation independently of a worker pane.
`clankie agents reports --conversation ID [--limit N] [--delivery-ids ID,ID]`
(or `worker_reports`) returns unread reports with their original delivery IDs
and exact text. Without a selector it returns the oldest first (20 by default).
For a fresh wake, use `--delivery-ids DELIVERY_ID` or
`worker_reports({ deliveryIds: ["DELIVERY_ID"] })` to read that report without
draining the backlog. Select 1–100 UUIDs; targeted reads default to up to 100
matching reports, ordered oldest first, and `limit` can lower that count.
All reads retain the 128 KiB full-page compact JSON byte budget; native/MCP
returns that bounded envelope directly, without a second clipping step. Only complete returned records are
offered. Unknown, already acknowledged and foreign-conversation IDs are omitted
without distinguishing them. `unreadCount` still counts the conversation’s entire
unread backlog, and only returned `ackDeliveryIds` are eligible for acknowledgment.
Reading does not mark them read. A report whose sending pane a complete
listing of its own fleet no longer shows is retired once it is an hour old
(VUH-2806): it is marked read without an acknowledgment to the gone sender, its
full record is appended to `retired-worker-reports.jsonl` in the service's state
directory first, and the conversation gets one notice per sweep. Pending
reports, reports from any pane still listed and reports from a fleet that
cannot be listed are never retired. After reviewing every offered report, run
`clankie agents reports ack DELIVERY_ID... --conversation ID` (or
`acknowledge_worker_reports`). Only fully offered IDs can be acknowledged.
The original sender receives durable channel events for stored, taken into a
lead turn, and acknowledged, including unadopted native panes. They need no
action, so they never wake an idle seat on their own: they ride with the seat's
next real event, such as a message from its lead (VUH-2249). Events remain
pending across reconnect until their transport acknowledgment; that transport
ack never marks the report read. Status lookup uses the original sender binding
and works immediately for returned IDs through both local and remote fleet links.
Add `--receipt '{"summary":"Filed the follow-up.","links":["https://linear.app/vuhlp/issue/VUH-1898"]}'`
to `reports ack`, or supply the equivalent `receipt` object to
`acknowledge_worker_reports`, to include a short result and resulting chat/issue
links in the automatic acknowledgment. Receipt events require no reply. The
worker sees the summary only after a `message_seat` reply from that conversation
reached it following the report; otherwise its receipt says no reply has
reached it and any question in the report is still open. The result lists those
acknowledged reports as `unanswered`, with an instruction, so the lead can see
an open question: an answer given elsewhere, such as the owner's chat, never
reaches the worker (VUH-2065).
You can pass the unmodified returned page on standard input with
`clankie agents reports ack --json-stdin --conversation ID`; the page must name
the same conversation. A page holds at most 100 IDs.
For reviewed, retained history, the owner can run
`clankie agents reports ack-history DELIVERY_ID... --conversation ID` to
acknowledge up to 1,000 explicitly selected IDs, including migrated receipts
that were never offered by the current runtime. This requires operator
authentication; captain and paired-device credentials cannot use it. Unknown
IDs or IDs from another conversation reject the entire operation. New reports
and reports outside the selected IDs remain unread.
The roster exposes per-worker unread receipts and the fleet retains report rows
for disappeared panes. A finished worker with pending or uncertain output shows
“done, report not delivered”; confirmed transport alone still shows “report unread”.
The console also lists retained reports under the agent dock.

New definitely queued or refused-before-handoff reports keep their original target
and may resume when its verified receiver returns. Crash-interrupted attempts and
legacy receipts remain uncertain and readable; they are never blindly resent.
A matching original thread may retain its output while requiring re-adoption;
that retention grants no control or dispatch until the owner repairs the binding.
The API uses authenticated operator dispatch operations `readopt_seat`,
`worker_reports`, `acknowledge_worker_reports`, and the owner-only
`acknowledge_worker_report_history`, each naming the exact owning
`conversationId`. Credential and conversation authority are checked again at
admission.

Same-thread `readopt_seat` preserves whether Clankie hired the pane, across
service replacement and on remote fleets. A proven hire remains eligible for
`close_worker_pane` by its lead, subject to the saved-report, draft and worktree
guards. Re-adoption or messaging alone cannot make a hand-started pane eligible;
legacy records with unknown hire provenance remain refused.

After a remote Herdr restore, the same completed hired session can have a new
terminal and process lifetime. `close_worker_pane` (including `clankie agents
retire`) recovers retirement authority only from an explicit persisted hiring
owner and one matching completed receipt on its unchanged configured host.
A complete census must find that exact idle session once, in its original pane
and directory. Fresh native process, shell and connection proof is captured and
rechecked through the final close guard. Missing original process proof can use
this route; missing receipts, unknown hire provenance, adoption, ambiguous
sessions and unconfirmed launches cannot. The lead history's `restoredHire`
records the original seat, receipt, census digest and new process proof. This
does not rewrite launch records, re-adopt the worker, grant project membership,
replay its brief or remove its worktree. Saved-result, styled-draft and
unlanded-work checks still apply.

`clankie agents retire PANE --conversation ID --reason TEXT [--report PATH]
[--unlanded-reason TEXT]` invokes `close_worker_pane` through the operator
conversation MCP API (`/v1/mcp?conversationId=ID`). Use a bare local
pane or a fleet-qualified remote address. Only the current owning lead can
retire its hire; the native output and nonempty saved report are kept first.
For a settled-abandoned fresh hire, `not_ready` names the retained allocation,
pane, fresh intent and native receipt. Settlement ends delivery uncertainty,
but retains the live allocation. Launched unconfirmed hires are eligible only
with their original receipt settled and matching original native
process birth, shell and connection proof. This does not create confirmed
project membership. Remote work and styled draft reads occur on the linked
host; unavailable or changed evidence refuses. Dirty or unknown work cannot be
overridden by a reason. After guarded retirement, complete successful inventory
must prove the original pane absent before the allocation releases. No brief is
replayed and no allocation is freed merely because delivery was abandoned.

`clankie agents keep PANE --conversation ID [--reason TEXT]` and `clankie agents
unkeep PANE --conversation ID [--reason TEXT]` invoke `keep_worker_pane` the same
way. A kept pane's current native session is skipped by automatic tidy (the
fleet `autoTidy` setting) until it is released; a new session in that pane is
not kept. Any authenticated conversation may keep or release a pane: keeping
closes nothing, and a lead's own `close_worker_pane` still closes a kept pane.
The result lists every current keep.

Without persisted adoption, the host reads the actual census parent/launcher
edge and routes to that exact native lead or its attached conversation. Explicit
adoption wins; tabs, titles and report text establish no ownership. The parent
needs an exact-session native mailbox, authenticated hook or existing harness
control/queue path. A room still needs its original Discord admission and grants.
If no eligible parent exists, the report falls back to `global-default` with
`workerReportRouting.source: "unadopted"` on its durable accepted turn and a
reason (`no_parent`, `parent_unavailable`, `parent_unlinked`, or `owner_removed`).
The fleet roster exposes the same diagnostic and parent pane/seat when known.
Observed launcher edges are retained by native child and parent thread identity.
After a Herdr reset, a missing edge is recovered only while one exact original
child and parent are live on the same fleet. A new actual ancestry supersedes
history; a changed, missing, or ambiguous parent cannot inherit it. Older launches
with no retained edge keep the explicit `no_parent` diagnostic.
An authority or occupant mismatch is `source: "refused"` with
`reason: "authority_unavailable"`; it does not admit a default fallback.
`clankie doctor` includes `linkedSession.parentLeads` and names lead panes whose
bridges are missing or unobserved, including their child panes. These process
observations do not prove native delivery or grant tools. Reconcile the original
report ID after uncertainty; restarting or adopting a worker never resends an
already accepted report to another conversation. Only definite pre-handoff recovery reuses its original target.
`clankie fleet set --tools off` stops new standing tool admissions. Each call
rechecks live admission, account binding and settings, but a call already past its
last asynchronous check can still reach a provider after tools-off or admission
loss. The strict refusal guarantee is not met; see
[ADR 0217](adr/0217-fleet-membership-gets-connected-tools.md) and VUH-1585. Manual
grants keep their existing restrictions.

Use `list_fleet_seats({})` to discover seats in the sender's own fleet, plus seats
on other fleet machines that the sender's lead also leads (VUH-2923), then pass
the returned recipient `seatId` as `seat` to `message_peer({seat, text})`. The
bridge obtains the sender and recipient bindings; workers do not supply them.
Both the Claude worker plugin and `clankie mcp --fleet` use `runSeatChannel` for
this path. The server requires the caller's proven native pane process and matching
session, confines recipients to the same fleet or the sender's own lead, and
checks their current binding.
Peer content reaches the existing `message_seat` native channel/session delivery
path as agent output, never an owner instruction. It records a server audit and
an agent-role message in Clankie's default transcript. Native channel events carry
`source: peer`; the exchange does not wake him or create an owner turn.

An uncertain peer send keeps its original receipt. Reconcile that ID through
`GET /v1/fleet/seats/{paneId}/peer-messages/{id}`; do not issue another POST,
delete receipt state or switch bridges to replay it. Discovery uses
`GET /v1/fleet/seats/{paneId}/peers`; new sends use
`POST /v1/fleet/seats/{paneId}/peer-messages`. These worker routes derive authority
from the admitted identity, not caller-supplied pane or fleet fields. Receipt reads
remain available with peer messages off. A lost recipient binding terminates
reconciliation as `recipient_gone` with outcome `unconfirmed`: delivery stays
unknown, the original is never resent, and fresh messages are allowed. An original
still unproven after 15 minutes settles as `superseded` (outcome `unconfirmed`)
the same way, and the next message to that seat says it follows it. An unresolved
original holds only its own recipient. The service
keeps full bodies for the latest 100 settled messages and all unresolved originals;
older settled bodies become exact compact receipts that still prevent ID replay.
See [worker access](worker-access.md#messages-between-workers).

`doctor.harnessBridges` reports installation, registration and invoking-process
membership separately. Remote project `eligibility: unsupported` does not mean
fleet tools are denied; `nativeTools: not-verified` still requires an actual native
catalog/call check. MCP sessions bind to fleet/pane (fleet only for bearer links)
and expire after 15 minutes idle. See [worker access](worker-access.md).

New Claude/Codex hires require the connected-tool wrapper pair and, when
`fleet.peerMessages` is on, `list_fleet_seats` and `message_peer` before starting
their brief, including native-first hires without a project allocation. The
wrapper catalog depends on fleet settings and admission; provider account and
native peer proofs are checked when invoking a tool. A temporary provider or
discovery failure keeps previously verified schemas in the native catalog.
Explicit settings changes remove disabled tools.

Each worker connected-tool request has a thirty-second total budget covering
initialization, catalog/account reads, remote invocation and the response body.
Timeouts report a reason and never replay an uncertain mutation. Concurrent
requests share one completed MCP handshake. Replacing a service provider
connection lets already dispatched calls settle on their original connection.
HTTP refusals retain the service's reason, including fleet admission errors;
cached schemas do not authorize a refused call. A `No durable native binding`
message receipt means the bridge could not prove its delivery binding and sent
no new message; inspect the pane's native binding before retrying delivery.

Connected reads do not run optional native write-attribution proof. Ordinary
connected writes bound that attribution separately while preserving fleet,
account, configuration and publication checks. Request cancellation follows the
local native proof queue, so an expired worker call does not keep consuming it.

An older running worker bridge can keep an exact terminal inbound receipt
unresolved even after the service and plugin files are updated. Version 0.6.2
accepted only positive stored receipts; current code also accepts the service's
matching `definitive: not_sent` fence. Refresh the MCP process that owns the call,
preserving the original thread and receipt file. The deployed operator outbox
pump fix does not reload a worker's already-imported parser.

For a Clankie-managed Codex seat with its original dedicated controller and
isolated copied config, the controller replaces only Clankie's connection by
updating `mcp_servers.worker.env.CLANKIE_CATALOG_REVISION` with
`config/batchWrite`, then calling `config/mcpServer/reload`. The next model step
uses the refreshed connection on the same loaded thread. Do not edit the owner's
config, restart a shared daemon, fork the thread or delete a claim. An embedded
or remote session without that controller needs its owner's exact-session
reconnect after the old runtime unloads.

After refresh, invoke `message_clankie` once to read the original receipt. A
matching positive stored result or terminal `definitive: not_sent` result settles
the retained claim; that invocation still sends no replacement. Invoke again
deliberately to send the later report. A timeout, unauthenticated or mismatched
lookup stays uncertain. See [the worker fleet regression evidence](testing/2026-10-05-worker-fleet-tools/README.md).

### Owner asks: `conversations questions [ID]` and `conversations answer`

Clankie's `request_user_input` is one structured ask tool across native seats
over MCP, the console, Discord rooms and service conversations. `purpose` is
`decision` (options plus recommendation), `approval` (an action the owner's
effective `autonomy.fleet` settings reserve), or `owner_action` (exact steps only
the owner can take). Built-in tracker verification uses `verify`; tracked run
approvals use `gate` with Approve/Decline choices. Both link the item through
the same mailbox. Legacy `preference` questions remain supported. `kind`
(`text` or `choice`) describes the answer control. Every new ask states
`waitingOn`; its host-bound `conversationId` identifies the source. Answers
never grant credentials, enroll a machine or change settings. Project creation
still requires its separate reviewed CREATE target.

Decision asks include `defaultAction` (up to 1900 characters) and `deadlineAt`
(UTC ISO timestamp) together. The owner sees both in the existing steps display.
If neither is supplied, the safe default leaves the requested change pending and
continues other authorized work after 24 hours. Existing pending decisions acquire
that same default and a deadline 24 hours after their original creation time.
Gates, approvals, verification, owner actions and native worker questions never
expire into permission.

At expiry, the service cancels the ask with reason `decision_deadline_elapsed`,
records service attribution and no owner answer, publishes one owner notice, and
queues one continuation asking the source lead to take its declared default
within existing authority and report the actual outcome. Both survive restart;
an interrupted accepted continuation remains visibly failed rather than being
replayed on uncertainty. An owner answer accepted before expiry prevents the
default. Elapsed time never grants money, account, credential or gate authority.

```sh
clankie conversations questions
clankie conversations questions --status pending
clankie conversations questions CONVERSATION_ID --request REQUEST_UUID
clankie conversations answer CONVERSATION_ID REQUEST_UUID --incarnation INCARNATION_UUID --revision REVISION --option OPTION_UUID
clankie conversations answer CONVERSATION_ID REQUEST_UUID --incarnation INCARNATION_UUID --revision REVISION --text 'Owner answer'
clankie conversations cancel-question CONVERSATION_ID REQUEST_UUID --incarnation INCARNATION_UUID --revision REVISION
```

The lead lane also has `cancel_question {requestId, incarnationId, expectedRevision}`.
Its host binds the source conversation: it cannot cancel another lead’s ask.
An overtaken question can be cancelled before asking its replacement. A repeated
cancellation reconciles the original without starting an answer turn. Periodic
fleet rounds surface pending questions older than 30 minutes to their source
lead with current targets, including when that lead has no current workers.

The global list defaults to pending asks. `--status submitted|cancelled` reads
retained resolutions; an optional conversation ID filters the list. Every entry
has the same immutable request/incarnation and current conversation revision
used by answer and cancel. Read again after `revision_conflict`; never answer a
replacement using an older displayed target. Answering the same request with
the same answer reconciles its original resolution; a conflicting answer is
refused. Pending or uncertain asks retain their IDs and are never recreated.
An answer resolves the ask on every surface and wakes its source with the
owner's attributed answer. A native source uses its existing native channel.

`/question` opens the console's centered owner mailbox; F8 opens it from the
composer too. It lists pending asks across all source conversations, newest
first, with the lead, linked item, what waits and age. Choose an ask for its
prompt, recommendation and steps, then choose an option or type an answer.
Send it back asks for a reason. Esc closes without answering. An answer keeps
the displayed request, incarnation and revision; a conflict re-reads that exact
request and asks you to open the mailbox again, without answering a replacement.

Text commands remain available: `/question list` lists asks, `/question read`
displays the selected source conversation's request for `/question answer NUMBER`,
`/question text TEXT` or `/question cancel`. Native worker asks can also use
`/question worker JSON` or CLI `--worker-stdin`, with a JSON map
`{"QUESTION_ID":{"answers":["Owner answer"]}}` covering every observed ID.

To escalate a pending worker question, Clankie supplies `workerQuestion` with
its observed `seatId` and native `requestId` to the same ask tool. The host copies
the real question and pins the original native session. The owner's answer
returns through the existing `message_seat` question-answer channel, with the
original request and question IDs, never terminal typing. Native delivery is
attempted once; uncertainty is retained and reported to Clankie in the source
conversation rather than retried. A changed occupant or resolved native question
cannot receive an answer to its replacement.
Claude operator and lead seats without an exact hiring conversation keep
`AskUserQuestion` in Claude's native prompt in their own pane. The hook supplies
no answers and does not claim app delivery. Hired seats still forward questions
to their exact lead. Other notification failures deny the invocation and include
the bounded, credential-redacted error cause in the hook reason and service log.
Permission requests always remain denied when notification fails, including
unowned seats; native question fallback grants no permission to another tool.
Local Codex async questions remain answerable when Clankie no longer has the
launch controller in memory. The host reconnects only to the dedicated Unix
socket observed on that exact native pane and verifies its original loaded
thread. It reads the structured question and uses attributed native user input,
steering the active turn or starting the answer when idle. A durable answer
claim precedes that input; uncertain acceptance remains held across restart.
Missing or replaced sockets and unloaded threads refuse rather than resuming
stored history, choosing an account daemon or using the native queue. Native
synchronous requests still require their original live controller.
Escalation requires an admitted machine turn; a social room can create its own
ask but cannot read the owner's private worker questions.

HTTP clients use `POST /operator/v1/dispatch` with `schemaVersion: 1` and
`op: "input_list"`, optionally `status` and `conversationId`. The result is
`{questions: [ConversationQuestionResult, ...]}`, newest first. A conversation
can have several open asks, each with its own `waitingOn` and immutable ID.
Answering or cancelling one leaves the others open. Revision is shared by the
conversation: after `revision_conflict`, refresh and answer the same request ID.
Pending asks and uncertain native claims are protected; creation refuses at
256 records or 512,000 serialized bytes per conversation instead of evicting them.
`input_get`, `input_answer` and
`input_cancel` keep their existing immutable target. All four operations require
an authenticated operator or an active device with `terminalControl`; a captain
bearer alone cannot read the owner mailbox or answer. Hosted devices use the same
contract without additional owner setup. The app mailbox consumes this API for
owner answers and informational updates.

Native seat attachment and polling leave unanswered questions pending in their
source conversation; takeover is not an answer or cancellation. Existing owner
and workspace checks still apply. New workspace preferences and project
confirmation remain unavailable while the native driver owns the conversation.
Existing workspace preference answers also refuse with `native_driver_active`
and stay pending, preventing a competing service continuation; owner asks with
semantic purposes retain their normal source answer delivery.

Question reads expose `resolvedBy: {kind: operator | device | service, id}`,
`resolvedAt`, and the cancellation `reason` code. The existing `input_resolved` event remains compatible with strict legacy
clients; refresh the question record to read attribution. Explicit cancellation names its authenticated caller;
automatic cancellation names the service. Submitted legacy records expose their
stored responder; older cancellations with no recorded actor leave it unknown.
Render `status: cancelled` as cancelled, never as an answer or selected option.
These records do not turn driver takeover into owner approval.

Approval routing reads the effective global/project `autonomy.fleet` leaves.
`lead` or `allow` means Clankie handles it and no owner ask is created; `owner`
allows the ask. Existing commit, push and release leaves are reused. Missing gate
categories refuse approval creation until VUH-1782 provides those settings;
this ask path introduces no gate presets, custom-rule evaluator or credentials.

### Owner updates

Clankie deliberately calls `mail_owner_update` when a result, media or landed
change is worth mailing. This is news: nothing waits on it, and reading or
dismissing it never starts a turn. It is separate from answers to asks.

```sh
clankie conversations updates
clankie conversations updates CONVERSATION_ID --state unread
clankie conversations read-update UPDATE_UUID
clankie conversations dismiss-update UPDATE_UUID
```

TUI: `/updates list`, `/updates list unread`, `/updates read UUID`, and
`/updates dismiss UUID`. Cards show title/body, source, optional worker, issue,
links/media, ID/time and read state. The same commands work in the hosted
console through its authenticated owner transport.

HTTP uses `POST /operator/v1/dispatch`, `schemaVersion: 1`, and
`owner_update_list` with optional `conversationId` and `state`
(`unread`, `read`, `dismissed`, `all`). Default lists nondismissed mail; result
is `{updates: [OwnerUpdate, ...]}`, newest first, at most 1000. Exact-ID
`owner_update_read` and `owner_update_dismiss` return
`{status, update?, reason?}`. Unknown IDs refuse. Repeating read/dismiss keeps
the original state; reading dismissed mail does not reopen it. All require
current owner operator or `terminalControl` device authority; captain credentials
cannot substitute.

`OwnerUpdate` has `id`, `title`, `body`, `conversationId`, `at`,
`source: {conversationId, seatId?}`, optional `links: [{label, url}]`, optional
`media: [{url, mimeType, alt?}]`, `state`, and optional read/dismiss timestamps.
The tool requires title (max 200) and short body (max 2000), and accepts optional
`seatId`, links/media (max eight each) and `issue: {tracker, key, url}`.
The source conversation is supplied by the host. Asks accept the same optional
`issue` reference; it enables navigation and grants no tracker authority.
Only HTTP/HTTPS links are accepted; media must already be published at a URL.

Per conversation, retain active news and 32 recent dismissed updates within
256 total records / 512,000 bytes. Capacity refuses new mail without evicting
active updates. Same publication identity/draft reconciles across restart;
a changed draft under that identity refuses. There is no automatic event feed.

The operator-seat MCP bridge assigns a fresh UUID to each deliberate mail call,
including calls with identical content. It keeps that UUID through an explicit
pre-admission reconnect/replay. The MCP result carries it in
`_meta["clankie/owner-update"].publicationId`; an exact retry must send that same
metadata and draft, including after a bridge or service restart. MCP request
counters and tool names are never publication identities. Older MCP clients
without this metadata receive a fresh host identity for each call. An unknown
transport failure does not automatically repeat mail: inspect the original
mailbox state before making another publication.

### `project create PROJECT --settings FILE.json --revision REVISION`

Requires a service build containing the local project-creation route; a source
landing does not update an installed CLI or the running service. Read
`clankie project list`, then review a proposal file and submit it with the returned
revision. `/project create` uses the same owner-authenticated API. Ordinary
preference answers do not authorize creation.

The file requires `name` and `workspacePath`; `PROJECT` and `REVISION` are explicit
arguments and cannot be supplied or overridden by the file. Optional `roles`,
`workerCap`, `trackerRef`, `trackerSetup`, `wipCap`, `ownerLoop`, `autoUpdates` and `hiring`
use the shared project policy vocabulary. Worker caps may be `null` to inherit;
zero stays an explicit zero. Retired fleet size/model settings cannot be created.

Creation accepts one existing canonical workspace on the service's local
machine. Its workspace ID is `primary`. Existing project IDs, path overlaps,
changed directory identity, changed authority and stale settings fail without
an automatic retry. Remote enrollment, linked roots, assignments and grants
are not part of this command; existing `project add` semantics are unchanged.
The pre-rename authority, directory, tracker and revision guards are asynchronous
observations, not cross-process compare-and-swap or atomic authority checks.

An optional tracker binding must be
`{"workspaceId":"primary","path":".clankie/tracking.json"}` and the valid saved
convention must already exist unless `trackerSetup` is supplied. For a workspace
without a saved convention, `trackerSetup` includes an explicit `backend`
(`default`, `markdown`, `github`, `linear`) and the existing work-init inputs:
`directory`, `githubRepo`, `linearTeam`, `linearProject`, `linearLabel`,
`decisions` and `note`. It requires that tracker binding and writes the same
`.clankie/tracking.json` as `clankie work init`, within the reviewed CREATE.
An existing convention or changed workspace, parent directory, owner authority
or project revision refuses initialization. It chooses no account and creates
no provider project or label.

In an unassigned owner workspace conversation, Clankie offers one “here's what
I picked” proposal through `propose_project_defaults`. He follows saved tracking
first, then detects Linear from repo links, branches and commits, GitHub issues,
or an existing file tracker; no tracker defaults to local work records. Competing
trackers or missing Linear scope produce one question. Builder and reviewer are
the baseline, and an app UI adds designer. A test suite adds no tester: it is
the builder's own check, and review stays independent
([ADR 0208](adr/0208-agents-carry-a-role-the-world-reads-it.md#amendment-roles-are-not-a-pipeline-james-2026-10-14)).
Each role has a one-line reason in the proposal evidence.

The default numeric worker cap is two. Repos with at least 1,000 source files
and 50 commits in the last 14 days can propose four. The numeric worker cap never
exceeds the observed resource governor's heavy capacity; pressure or missing
observations propose zero workers. These are
reviewed defaults, not resource permits; the live governor still admits hires.

`project_proposal_get` returns the single proposal object and its exact target.
`project_proposal_confirm` accepts it through the existing durable save.
`project_proposal_tweak` takes that target plus one `change: { field, value }`,
where `field` is `name`, `roles`, `workerCap`, or `tracker`. A tracker
value contains `trackerRef` and optional `trackerSetup`. A tweak saves no project
or tracker: it creates a fresh proposal/hash/revision for review. Accepting an
old target is refused. Confirmed project roles become the station definitions;
the app's presentation and confirm card remain part of its redesign.

The CLI exposes the same operations:

```sh
clankie conversations project-proposal ID --request UUID --incarnation UUID
clankie conversations accept-project ID --request UUID --incarnation UUID --revision N --proposal UUID --artifact SHA --projects-revision SHA
printf '%s' '"My project"' | clankie conversations tweak-project ID --request UUID --incarnation UUID --revision N --proposal UUID --artifact SHA --projects-revision SHA --field name --value-stdin
```

`confirm-project` remains an alias for acceptance. `propose_project_create`
allows a custom proposal after an ambiguous answer or a requested choice.
Preference answers alone never save settings. Confirmation consumes the proposal
once. Tracker and project settings are two file writes: a failure after tracker
save can leave only the tracker. An uncertain confirmation or tweak is checked
with the original locator, never replayed. A chosen built-in tracker gets its
own local project. No external provider project, label or account is created,
and no workers are hired by acceptance. Project village visuals
belong to VUH-1710.

### `project list`, `project settings` and `project update`

`clankie project list` reads the current project settings and their revision.
`clankie project update PROJECT --changes FILE.json --revision REVISION` submits
reviewed changes for an existing project through the authenticated service API.
The console exposes the same verbs through `/project`.

The changes file may contain `name`, `roles`, `workerCap`, `trackerRef`,
`trackerProjectId`, `linearProjectBinding`, `autonomy`, `auto`, `focus`, `productPaths`
and `linkedRepos`.
Omitted fields remain unchanged; `null` removes a worker cap, tracker binding
or focus. `auto: true` puts the project on Auto: Clankie works its backlog
unprompted while [`auto`](#auto-switch) is on, and starts nothing new on it
otherwise. `focus` is one line (at most 280 characters) on what matters now;
it steers that work. Snapshots advertise both with `projectsAuto: true`, and like
`trackerProjectId` they appear only in the `?includeAutonomy=true` view. That
view also carries `projectStatus`, each project's status line by ID, read live:
`agentsWorking` (seats on this machine working in its local workspaces or
worktree roots), `landedToday` (commits on each local workspace's fetched
`origin` default branch since local midnight, absent without one) and `needsYou`
(pending owner questions raised in its workspaces), plus a top-level `needsYou`
counting every pending owner question.
`productPaths` is an optional list of 1–32 repository-relative POSIX globs,
each at most 256 characters. Absolute paths, backslashes, `..` and control
characters are refused. A directory such as `inject/` includes its descendants;
patterns such as `src/**/*.ts` are also accepted. Only matching paths count as
product; other paths count as docs (`docs/` or Markdown) or tooling. Lockfiles,
generated files and binaries are always excluded. With no declaration, test,
fixture, rig, script, tool and CI paths are tooling, docs and Markdown are docs,
and everything else is product. Set `productPaths` to `null` to restore that
default; an empty list is refused.

```sh
clankie project list
# Use the returned revision with a changes file containing, for example:
# {"productPaths":["inject/","common/","server/","runtime/","tools/launcher/","tools/packaging/","content/"]}
clankie project update PROJECT --changes product-paths.json --revision REVISION
clankie project list
```

The CLI requests the autonomy-aware view by default. That view advertises
`productPaths: true` and includes each project's declaration; the plain API view
omits both for older strict clients. In the TUI, `/project` → project →
**Product paths** edits the same list (JSON; empty input restores the default),
using the same revision fence.

`trackerProjectId` binds the project to one built-in tracker project by its UUID
(from `work sync` bootstrap or `work owner get_project`); the service refuses a
UUID the tracker does not hold (`tracker_project_not_found`) or one already bound
to another project, and never matches by name. `clankie work repos` and the
device `work_repos` read return it on that project's repo, so the app can mark the
synced tracker project as bound. Snapshots for clients that do not opt into the
current project shape (`?includeAutonomy=true`) omit it, like `autonomy`.
`clankie project settings PROJECT --tracker-project UUID|clear` and the
**Built-in tracker project** field in `/project` edit this same reference through
the revision-bearing owner API. Unknown projects, revoked owner authority and a
tracker store replaced before commit refuse the edit; a duplicate binding
returns a conflict. Unavailable tracker reads preserve the saved reference and
withhold it from work-repo projections until it can be verified again. If the
saved backend is built-in, changing or clearing this reference through the
legacy route is refused: use the work tracker preview and explicit confirmation
instead. Clearing an inactive reference leaves the project and its workspace
tracker choice in place.
In the app's Common-tier Project settings, choose **Built-in tracker**, enter
**Built-in project ID**, then review and confirm the change. This uses the same
work-tracker API and exact UUID validation. Empty input reuses the saved built-in
binding, or creates a tracker project when none exists; it does not clear one.
The UUID belongs to one tracker store and stays in project settings, never in
committed `.clankie/tracking.json`. `work init` records the repository convention;
use `project update` for an inactive binding or the confirmed tracker-settings
flow for an active built-in project. Linear cutover applies the import report's
mapping automatically.

`linearProjectBinding: {"provider":"linear","projectId":"UUID"}` separately
names an exact project in Clankie's connected Linear app. The service reads that
provider directly, never the local tracker fallback; names, another provider,
an unknown UUID or a duplicate binding are refused. An unavailable connection
returns `linear_project_unavailable` (503), without changing settings. `null`
clears only the Linear reference; an existing built-in `trackerProjectId` remains
unchanged. The binding is a reference, never a saved repository backend switch,
account selection or authority grant. Auto wakes carry the provider and UUID,
and explicit lead routing can use either binding. Its change resets the round's
fingerprint. Autonomy-aware snapshots advertise `linearProjectBindings: true`;
plain strict snapshots omit both the capability and binding.

`clankie project settings PROJECT --linear-project UUID|clear` reads the current
revision and writes through the same owner API. `/project` offers **Linear
project** on supporting services. The app control follows on that same API.

An empty roles list inherits the six built-in roles; an explicit list defines
the available roles and may set their whole hire profile (harness, model, effort,
subagents, delegation, account, placement), naming rule and concurrency cap. Zero
prevents new hires, while an absent cap adds no limit. These settings affect
new hire admission, not the configuration of already running agents.

The service validates the whole resulting project settings document, preserving
workspaces, roots, assignments, grants, label mappings and unrelated projects.
Stale revisions or removal of an in-use role fail without overwriting the saved
settings. Read the settings again and review the changes before retrying.

`clankie project settings PROJECT` prints stored autonomy overrides
and their current effective values, plus `auto`, `focus` and the `reviewer`. `--auto on|off` and
`--focus TEXT|clear` set those in the same revision-fenced update. Add `--closure lead|owner|inherit` or
`--machine-setup lead|owner|inherit`, `--commit lead|owner|inherit`,
`--push lead|owner|inherit`, `--release lead|owner|time_rule|inherit`
(with `--release-rule TEXT` for `time_rule`) to change only that leaf through
the current revision-bearing owner API. Missing leaves inherit the global setting independently;
`inherit` removes the selected override without changing its sibling. The console
accepts the same syntax as `/project settings PROJECT ...`.

`--link-repo PATH` and `--unlink-repo PATH`, each repeatable, edit the project's
read-only linked repos
([ADR 0298](adr/0298-linked-repos-are-read-only-sources.md)). A linked repo is
another project's workspace. Guided reviews on this project's built-in issues may
read it, and Auto churn counts its commits that name one of this project's issue
keys. It never makes the project an owner. Settings context, the review gate, hire
placement and membership ignore it, so the owning project keeps its checkouts. The
CLI resolves PATH to its canonical path. The service refuses (`linked_repo_refused`, 400) a path that no project owns, one that more than one project owns, or one of
the linking project's own workspaces. Removing a workspace that another project
links is refused until it is unlinked. The JSON update takes `linkedRepos` as the
whole list of `{"machineId","platform","path"}`, or `null` to unlink all. Readers
see it in the `?includeAutonomy=true` view, advertised by `linkedRepos: true`, and
`project settings` prints `linkedRepoPaths`.

`--reviewer-role ROLE`, `--reviewer-seat SEAT` or `--reviewer none` names or
clears the project's standing reviewer
([ADR 0287](adr/0287-a-standing-reviewer-gates-every-landing.md)). A role such as
`reviewer` resolves to the live seats holding it and is the better default,
because seats retire; a seat is an exact `FLEET/term_…` ID. While a reviewer is
set, `pnpm check:landing` exits 3 until the reviewer approves the exact patch
(see [`review`](#review)). Seats already working in the project keep a way to
submit: the result's `reviewSubmit` names `submit_for_review` and, for a seat
whose catalog lacks it, `clankie review submit` from its own pane. The JSON update accepts `review` as `{"role":"ROLE"}`,
`{"seat":"SEAT"}` or `null` to clear. Readers opt in with `includeReview=true` and
see `review` and `projectReview:true`; the CLI and TUI opt in automatically, and
a service without `projectReview` refuses the flags. The `/project` menu has a
**Reviewer** row.

```sh
clankie project settings garden --closure owner
clankie project settings garden --machine-setup lead
clankie project settings garden --closure inherit
clankie project settings clankie --release time_rule --release-rule "Release without asking every Friday when main has user-visible changes worth shipping."
clankie project settings garden --commit owner --push inherit
clankie project settings garden --wip-cap 6 --owner-loop milestones
clankie project settings garden --auto-updates off
clankie project settings garden --reviewer-role reviewer
clankie project settings garden --reviewer none
clankie project settings clankie-work --link-repo ~/dev/clankie --link-repo ~/dev/clankie-app
clankie project settings clankie-work --unlink-repo ~/dev/clankie-app
```

Projects expose work policy with `projectWorkPolicy:true` when API readers use
`?includeAutonomy=true&includeWorkPolicy=true`. Older views omit these new fields
but retain the revision of the full settings document. The CLI and TUI use this
opt-in automatically; unsupported hosts cannot accept the new controls.

`--auto-updates on|off` controls evidence-first progress updates (default on).
The shared revision-fenced API accepts `changes.autoUpdates` as a boolean; `null`
restores the default. Creation accepts it too. Project settings and round readers
opt into the additive fields with `includeAutoUpdates=true`; project responses
advertise `projectAutoUpdates:true`. CLI and TUI opt in automatically. Existing
app builds need a project Settings control and this query capability before
exposing the toggle.

`--wip-cap 1..1000|none` caps Started tracker issues, independently of running
workers. Above the cap, Auto measurement and read-only historical replay emit
`over_wip`. `--owner-loop silent|milestones|landings|inherit` controls Auto owner
reports: silent requests none; milestones (default) reports closed milestones;
landings also aggregates newly observed origin commits. First observation is a
baseline. Definitively refused deliveries retry; delivered or uncertain claims
are retained across restart. Measurement and drift detection continue in silent
mode. Auto history/replay API readers use `includeWorkPolicy=true` for numeric
caps and cadence fields.

The same JSON update accepts `hiring` with `lead` and `worker` launch profiles,
`allowedPlans`, `excludedPlans`, `allowedModels` and `excludedModels`. Plan keys use the observed
provider and tier, such as `claude:max_20x` or `codex:pro`; one allowed plan pins
it. A singleton `allowedModels` similarly pins a canonical registry model ID.
Exclusions win, including over explicit requests. Profiles default harness, model
and account; explicit hire
fields win over role, project profile and fleet defaults, in that order.
`hireKind:lead` selects the lead profile without granting authority. `hiring` is
a whole-value replacement: merge the read value before changing a nested field;
`null` clears it, and omission preserves it. The TUI offers the same fields.

Each fresh work hire supplies an effort rationale for this job; its explicit or
project/role effort must be the smallest that meets acceptance. Fleet-wide effort
is never applied. Claude/Codex work hires require plan usage observed within five
minutes, preserve a 10% reserve for running work, and honor owner holds and project
constraints even when an account is pinned. Automatic choice ranks observed spare
plan capacity per day. Admission records plan, remaining usage, model, effort and
rationale in the hire receipt and project journal. No existing seat is stopped.

Owner app composes with a first message send `ownerWork: {surface}` (phone,
tablet, web or desktop). The service verifies owner authority and records
`owner-chosen via app (<surface>)`; the owner need not write a rationale. Effort
uses the owner's choice or role/project profile, otherwise the native default,
recorded explicitly. Agent-initiated jobs still supply their own effort rationale.

An ownerWork refusal can include `admission` with plan, remaining fraction,
reset, reason and `canOverride`. An explicit retry with
`ownerWork.overrideUsage:true` may override only the new-hire reserve on a known,
nonzero, otherwise usable plan. Holds, project exclusions, unavailable/stale usage,
exhaustion and other authority/capacity gates remain binding. Older clients that
do not opt into ownerWork retain the existing result shape.

For a reviewed JSON update, `autonomy: { "fleet": { "closure": "owner" } }`
sets one override; `autonomy: { "fleet": { "closure": null } }` clears it. No
defaults are copied into project overrides. API readers request
`?includeAutonomy=true` to receive project autonomy and `autonomyDefaults`;
the default response preserves the older project snapshot shape. New fleet/context
and autonomy-aware project responses advertise `workingPreferences:true`; an
older response keeps new leaves absent. The app hides unadvertised working
preference controls while retaining existing closure/machine-setup controls.
Release mode and rule are replaced or inherited together. These settings
grant no workspace, machine or tool authority. Machine setup derives its project
from the actual canonical caller workspace; an explicit `--project` must match
that context and cannot select a more permissive override.

`trackerRef` selects an existing project workspace and the fixed path
`.clankie/tracking.json`. It does not initialize a tracker, select an account or
register a repo. The app's existing work reader receives a read-only virtual
repo for the binding. Only an exact canonical workspace on the current local
machine is readable; remote, missing or changed sources report unavailable.
Existing registered repos remain independent. Project label mappings are
preserved but this editor does not apply them to station placement.

### `project add NAME --workspace PATH [--machine ID --platform windows|posix]`

The owner can approve one local project workspace with `clankie project add NAME
--workspace /absolute/canonical/path`. This local settings command requires the
canonical broker operator credential and an existing directory with exact canonical
spelling. A new project ID creates a project; an existing ID appends one workspace
while preserving its name, roles, caps, tracker, grants and assignments. Duplicate
or nested-overlapping local workspaces are rejected across all projects, including
the same project. Appended workspace IDs are derived deterministically from the
machine, platform and canonical path. It creates no roles, assignments or tool
grants. Fleet connected-tool access is independent of these project approvals.

`--machine ID --platform windows|posix` registers a workspace on a linked machine
instead, spelled exactly as that machine spells it (this host cannot canonicalize
it). Use the fleet ID you hire with, for example
`clankie project add rivals --workspace 'C:\Users\me\repos\rivals' --machine pc --platform windows`.
`hire_agent` with `fleet` uses the hiring conversation's own project when it has
one, and it stays pinned. A conversation without a project, such as the global
operator seat, can hire on a linked machine only into a folder at or under a
registered workspace of that machine: one registered under the machine's ID, an
alias, or any of its connections, since connections to one machine share its
files. The platform must match and the spelling must match exactly, including
case on Windows. A folder in several projects needs `projectId`. Anything else is
refused with the `project add` command to run. The fleet's own directory grant
(`clankie runtime workspaces FLEET --dir PATH`) is still required separately.

### `access` and `mcp --grant FILE`

`clankie access linear [verify]` reads or verifies the connected account.
`access list`, `access issue REQUEST.json --out GRANT.json` and `access revoke ID`
manage individual worker grants. The private file feeds `clankie mcp --grant FILE`,
which serves only granted tools and loads no operator bearer or seat channel.
Tokens expire after at most 15 minutes and require explicit reissue.
Revoking a manual grant closes its MCP sessions and refuses pending calls at
the final dispatch boundary; it cannot undo an already-dispatched provider effect.

`access project NAME SERVER [--tool NAME]...` retains legacy project-grant records
with no bearer delivery; they no longer gate fleet tools. `access fleet` remains
retired. Use `fleet set --tools off` to disable standing fleet tools.
`/access` exposes status, verification and revocation; issue from the terminal.
See [worker access](worker-access.md) for restrictions and account bindings.

### `stance <working|thinking|stuck|hauling|resting|celebrate> [--activity KIND] [--note TEXT] [--for SECONDS]`

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

`--activity reading|editing|testing|planning|waiting` explicitly states the kind
of work for the World activity bubble. For example, before a generic shell test
run: `clankie stance working --activity testing --for 60`. The roster/fleet read
returns `seat.activity` with its kind and `source: stated`, or `native_tool` when
a fresh outstanding known native tool establishes it. A Codex code-mode `exec`
counts only when its whole source is one literal call of a known tool; shell and
multi-call scripts stay unknown. Unknown kinds are refused;
notes and shell arguments are never classified. Omitting `--activity` on the
next stance clears it. The statement expires, belongs to this exact occupying
session, and is absent for idle/offline seats. Unsupported native telemetry
can still carry a live explicit statement; absence means unknown.

### `discord [status]`

Return stored and effective non-secret Discord configuration:

Server ownership and room skill grants use the same revision-fenced Discord
settings API. `discord owners --server ID --owners me|everyone|role
[--owner-role ID] [--role participant|admin]` sets one server policy;
`discord room-skill --server ID --channel ID --skill house-hunting|off` adds or
removes the bounded household capability. `me` uses `ownerUserId`; `role` needs
an authenticated membership check. Admin never grants the machine to members.
Legacy guild/channel machine IDs are retired. `discord set --servers JSON
--room-skills JSON` remains the Advanced repair path. See
[Discord authority](discord-rooms.md) and [ADR 0251](adr/0251-discord-owners-and-room-skills.md).

`discord legacy-author --household existing|SERVER-CHANNEL --user ID --author
LABEL --confirm` records one owner-confirmed, exact legacy author label for an
authenticated Discord ID. Get the owner's confirmation for each binding first;
never infer it from a display name or message. `--remove` replaces `--confirm`
to revoke that exact household/label/ID binding. No live ledger is rewritten.

The same revision-fenced `POST /v1/discord/settings` accepts
`houseHuntingAuthorBindings: [{"household":"existing","userId":"100000",
"legacyAuthor":"Legacy author","ownerConfirmed":true}]`. Household keys are
`existing` for the migrated household or the numeric `SERVER-CHANNEL` room key.
The TUI exposes this JSON under `/discord` → Advanced and confirms each new
entry individually. Older clients that omit the field preserve existing bindings.
Use `[]` (or CLI `none`) to clear it explicitly. Numeric legacy authors are
refused; they already identify Discord speakers.

`discord forum bind --server ID --forum ID --project TRACKER_PROJECT_ID
[--member-posts auto|owner_tag] [--member-limit N] --confirm-audience` binds a
forum as a two-way view of a built-in tracker project (VUH-2531); `discord forum
unbind --forum ID` removes it, and `discord status` lists bindings. The project
is the built-in tracker's project UUID (`trackerProjectId`). `discord set
--tracker-forums JSON` and the revision-fenced `POST /v1/discord/settings`
(`trackerForums`) are the Advanced paths. The host refuses a new binding unless
the project exists in the built-in tracker and the body's directory shows the
channel as a forum in that server (`tracker_forum_project_not_found`,
`tracker_forum_not_found`, `tracker_forum_not_a_forum`,
`tracker_forum_unverified`); unchanged bindings are not proved again. The work
tracker read (`clankie project settings PROJECT`, `GET /v1/operator/work-tracker?projectId=ID`)
shows a project's bound forum as `discordForum`. Binding does not import the
forum's earlier posts. Posts, replies and tag changes made while the service or
the bot was offline are caught up at the next start and every ten minutes.
Everyone who can read the forum sees that project. Posts are items, moderated
status tags carry their status and replies are comments; members' posts are
untrusted Backlog items, or wait for an owner's status tag with `owner_tag`.
Status tags count only when the audit log names an owner, so give the bot View
Audit Log. Restart the Discord body after binding the first forum: it then asks
for the message-content intent. Design and limits:
[the forum view proposal](proposals/2026-10-21-discord-forum-tracker-view.md).

Binding alone changes no decisions. Only a new `house_hunting` reconsideration
by that authenticated ID appends its authorized legacy targets. Original author
labels remain readable; other people and later rejections keep excluding homes.
Removing a binding affects future reconsiderations, not recorded history. See
[ADR 0252](adr/0252-household-legacy-authors-need-owner-confirmed-id-bindings.md).

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

### `discord official [status|on|off]`

The free official Clankie bot through the signed-in Clankie account
(VUH-1766). The command calls the running service's `/v1/discord/official`
route, the same one the app uses, so on and off take effect without a restart.
`on` requires `clankie remote-access on`, refuses when this machine's own bot is
the official application, sets `discord.officialBotEnabled` and registers an
ingress key with the account; the owner then chooses Add to Discord at
`installUrl`. `status` returns the setting, whether this service is
`running` the route, and the fleet's report (`registered`, `discord`, `usage`
per named limit, and `blocked` with its scope and reason). `off` clears the
setting, stops the route and removes it from the account, which disconnects the
server.

```json
{
  "ok": true,
  "schemaVersion": 1,
  "enabled": true,
  "running": true,
  "signedIn": true,
  "installUrl": "https://api.clankie.bot/fleet/account/?discord=self-hosted",
  "official": {
    "registered": true,
    "installUrl": "https://api.clankie.bot/fleet/account/?discord=self-hosted",
    "discord": { "connected": true, "guildName": "Studio" },
    "usage": [{ "limit": "account_messages_per_day", "used": 12, "max": 500, "resetsAtMs": 1791417600000 }]
  }
}
```

`GET /v1/discord/official` (observe access) returns that status without `ok`;
`POST /v1/discord/official` with `{"enabled": true|false}` (operator access,
Take Control in the app) changes it and returns the new status. A refused `on`
changes nothing and answers 409 `{error, detail}` with `not_signed_in` or
`official_application_is_local_bot`, or 502 `fleet_unavailable`. The app reads
through the encrypted gateway to the service's observe-authorized route and
writes through the hosted operator bridge. A hosted body answers 404
`official_bot_unavailable`; it already uses the official bot. Contracts are in
`@clankie/protocol/official-discord`.

When the account report cannot be read, `fleetError` and `next` explain the
unavailable report. The local `enabled`/`running` values remain local facts,
not proof that the bot is connected to a server. Refresh `status` after fixing
account availability; a refused `on` changes no settings, and `off` can stop the
local route while the report is unavailable.

### `discord directory [servers|channels|roles|people] [--server ID] [--limit N] [--after ID]`

Read the names, IDs and kinds the active Discord account can see. The default
lists servers; channels, roles and people require `--server`. Pages contain at
most 200 entries (default 100); pass the returned `nextCursor` as `--after`.
`state` and `reason` distinguish a disconnected runtime, partial cache and
failed read from a complete empty list. People and channel/thread coverage may
be partial. No account is connected or configured by this command. Requires
operator authentication. See [the directory contract](discord-rooms.md#discord-directory-for-settings-pickers).
Hosted bodies obtain this view from the managed provider, restricted to their
bound server and current installation, without a local Discord control port.

### `discord definition`

Read the host's shared Discord setup definition, check kinds, Advanced groups,
choice labels and role-correct invitation URL as JSON. Requires operator
authentication, like `discord rooms`. The host supplies its computer name.
See [Discord settings](discord-rooms.md) and
[ADR 0227](adr/0227-discord-connects-a-server-with-a-role.md).

### `discord setup`

Read all configured guild policies and setup checks. TUI `/discord` edits each
joined server's role, owners and options independently through the same
revision-fenced settings API. Inviting another server never changes existing
servers. Raw policy JSON and individual compatibility grants live in Advanced.

```sh
clankie discord status
clankie discord setup invite --role participant
clankie discord server --server 10001 --role admin --owners me --fleet on
clankie discord server --server 10002 --role participant --owners role --owner-role 60001 --fleet on --fleet-channel 20002
clankie discord server --server 10002 --tracking project_activity
clankie discord server --server 10001 --fleet off
clankie discord setup check
```

`discord.guilds` holds each guild's `role`, `owners`, optional `ownerRoleId`,
`fleetEnabled`, optional `fleetChannelId` and `trackingLevel`. The old
`discord setup connect|fleet|tracking` commands remain compatibility writers
for the legacy selected guild. Prefer `discord server` for independent edits.
Existing single-server options migrate unchanged; other known policies retain
role and owners and begin with fleet/tracking off. New automatic Admin group
rooms use the first enabled Admin; existing groups retain one webhook in their
own guild. Participant messages go to each enabled guild's designated channel.

Participant uses Discord's own permissions to decide which rooms Clankie can
read and speak in. Admin is for a dedicated server: the invitation requests
Administrator and Clankie controls channels, categories, roles, webhooks and
members. Server deletion and ownership transfer are always refused.
Selecting a role never grants access to the operator's computer.

Fleet display and tracking are independent. Participant projection messages
use the designated `fleetChannelId` under Advanced; no channels or webhooks are
created. Admin can create fleet channels and mirror tracked projects as channels
or forums, with one thread/post per issue. Tracking levels are **Off**,
**Project updates only**, **Project activity** (status changes, milestones,
new/finished issues) and **Every issue notification**. Disabling display or
tracking preserves retained mappings and connections.

The invitation requests the selected role's grants. Setup checks the connected
body's gateway evidence: proven denials say **needs** and missing evidence says
**not checked**. Admin requires Administrator; Participant checks its normal
text, thread and voice grants. Channel overwrites still control Participant's
actual access. Reading setup and saving controls never post to Discord.

Each control saves through the authenticated host API. A stale edit fails rather
than overwriting someone else's changes. Hosted consoles and CLI use their
existing encrypted transport. Raw local fields and credentials are not written
through a hosted connection. Body settings retain their existing restart
requirement; a save does not claim the running gateway has applied it.
Managed edge policy synchronization is reported in `managedPolicy`: a saved
body revision can be pending while the edge retries. Only `synced` identifies
the revision the edge acknowledged. The hosted dashboard edits the same role
model using a Discord-only signed owner bridge; disconnect/reinstall revokes
that account connection grant and refuses later admissions.

The explicit diagnostic `clankie discord setup test-post --channel general`
remains available. It requires settings-level operator authority, a current
revision, exact account identity and verified Send Messages. Missing native
receipts return `unconfirmed`; inspect the room before deliberately trying
again. It is never part of opening or saving setup.

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

`clankie discord set --main-conversation-channel-ids CHANNEL_ID` explicitly links
private text channels to the main conversation. Use comma-separated IDs
to replace the list, or `none` to unlink all. The shared settings field is
`mainConversationChannelIds`. Only the configured owner speaking through the
bot in an owner-only audience under an `owners: me` server policy and current
machine grant qualifies. A linked room-skill channel is refused. Privacy, owner
or link changes suppress pending and saved replies. The conversation uses its
existing native or service runner without a room messenger agent; uncertain
native deliveries are never replayed. Only the correlated answer returns to
Discord; unrelated main-conversation output stays private.

Set several fields atomically, or reset fields to their schema defaults.
Field flags are the `settings.json` camel-case names in kebab-case. Lists are
comma-separated (`none` clears); booleans accept `on|off`, `true|false`, or
`enabled|disabled`; integer fields require whole numbers. Zod validates the
completed settings document and the settings writer rejects token-shaped
values.

| Group                  | Fields                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Application and roles  | `application-id`, `guild-id`, `swarm-guild-id`, `ambient-role-ids`, `ambient-user-ids`, `approval-role-ids`, `owner-user-id`                                                                                                                                 |
| Machine grants         | `system-actor-user-ids`, `system-actor-guild-ids`, `system-actor-channel-ids`                                                                                                                                                                                |
| Text and presence      | `text-ingress-enabled`, `ingress-guild-ids`, `ingress-channel-ids`, `ingress-dm-policy`, `ingress-dm-user-ids`, `ingress-context-messages`, `wake-trigger`, `ambient-channel-ids`, `tool-progress-channel-ids`, `presence-guild-ids`, `presence-channel-ids` |
| Voice                  | `voice-enabled`, `voice-guild-ids`, `voice-channel-ids`, `voice-channel-id`, `voice-join-policy`, `voice-consent-policy`, `voice-transcript-logging-enabled`                                                                                                 |
| Body selection and lab | `active-body`, `user-session-enabled`, `user-session-guild-ids`, `user-session-channel-ids`, `user-session-voice-enabled`, `user-session-voice-channel-ids`, `user-session-dm-policy`, `user-session-dm-user-ids`                                            |
| Activity               | `activity-application-id-gba`, `activity-tunnel-name`, `activity-tunnel-hostname`                                                                                                                                                                            |

`wake-trigger` decides what wakes him for ordinary text chat: `mention` (an
@mention, a DM, a reply to him or `/clankie ask`; writing his name without an
@mention does not count), `name` (also his name or an alias in plain text), or
`any` (every admitted message; he decides whether to answer). `clear
--wake-trigger` restores the body's default: self-hosted follows the persona
`--reply-policy` (`all` → `any`, `addressed` → `name`), hosted uses `mention`.
`addressed` is the earlier spelling of `mention` and is saved as `mention`.
An explicit `mention` or `name` trigger also applies after he replies: ordinary
follow-ups do not wake him through the persona's live-message window. Clearing
the trigger preserves that window and the existing self-hosted reply policy.
`ambient-channel-ids` (hosted and official bot only) lists channels whose recent
chat is kept briefly, encrypted, as context for his next wake; empty means none.
How readily he joins in once something reaches him is the persona
`--chattiness`. In the TUI, `/discord` → **What wakes him / how much he talks**
edits the wake trigger, chattiness and reply policy together.

`active-body` is `bot` or `user_session`. These commands never accept Discord
tokens and do not perform the lab-user ToS opt-in. The main TUI `/discord` flow
uses the shared host definition and revision-fenced API writer. Advanced keeps
the existing local credential and opt-in flows on the broker and service HTTP
catalog; its raw field editor uses host revision checks.

### External native agent chats

Herdr discovery provides agent identity, routing and status. It does not import
external conversations or create chat threads. Opening a persona chat and using
the existing `replay`/`tail` operations reads the harness session on demand,
including messages, tools, typing state and contained images. Native cursors are
opaque; clients follow the returned recovery cursor after a session or history
change. The host persists the source locator, not a second native transcript.
Explicit app sends and native messages remain durable host communications.
An unadopted worker report can create its linked native parent's seat thread to
retain the report's delivery receipt; discovery alone still creates no thread.
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
conversation pruning. Captures are conversation checkpoints and do not assert a completed task. Pi transcript
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

The worker plugin uses the matching fleet link when available. Only transport
proof of the current native pane/session can register or drain its next-turn
mailbox; a bearer-only lifecycle report cannot. Without a live channel,
`message_seat` reports `deliveryStage: stored` for an observed receiver and holds
the reply up to 24 hours. The synchronous `UserPromptSubmit` hook writes it as
additional context once and acknowledges its message IDs after stdout succeeds.
That receipt means bridge delivery, not model consumption. A lost handoff remains
`uncertain` and is never automatically replayed. Sessions without an observed
receiver remain unavailable.

Queued originals are exposed as `waitingMessages` on the owner fleet roster:
`stored` waits for the next prompt; `unconfirmed` means the hook took mail but
has not acknowledged writing its output. The TUI highlights these seats even
when idle, and a durable owner update names the waiting pane without copying
message bodies. Restarting the service preserves these warnings; acknowledgment,
expiry or replacement of the native recipient clears the current roster warning.
A channel can wake an idle Claude session only when Claude was started with
`--channels plugin:clankie-worker@clankie` and policy permits it. Installing the
plugin or enabling policy alone does not enable channels in an existing process.
The service never repairs an unavailable channel by typing a draft into a pane.

A hand-started Claude in a linked Herdr pane now shows a startup warning with
`claude --resume SESSION_UUID --channels plugin:clankie-worker@clankie` when
that session lacks the worker channel flag. This is the supported one-command
restart fix; a plugin hook cannot change the already launched session's flags.
The notice uses the exact native UUID, stays visible if the lifecycle report
fails, and says “cannot confirm” if launch observation is unavailable. Existing
opted-in sessions, unrelated panes, Codex and print mode stay quiet. An explicit
interactive development-plugin opt-in also suppresses it while retaining
Claude's confirmation and organization policy. The hook never restarts a pane
or changes shell configuration.

The roster also exposes Claude's `messageReceiver`: `live` for an exact-session
native event poll, `next-turn-only` for an observed prompt hook without a live
poll, and `unverified` when neither is observed. Live polling does not prove
model consumption. Next-turn-only stays highlighted even before mail is queued
or after its queue is acknowledged, and stored adoption/message receipts warn
about the idle-wake limitation. The detail supplies the original session's
command: `claude --resume SESSION_ID --channels plugin:clankie-worker@clankie`.
`clankie herdr agent list` adds these roster fields to Herdr's rows. The roster
answers within three seconds: when the live projection is still running it
returns the last completed roster and says on stderr that it is partial and
which read is pending. When the roster cannot be read at all it prints Herdr's
rows unchanged and says why on stderr, so a missing `owner` is never mistaken
for an unowned seat.
Use the original cwd and account/config home after coordinating any stop or
resume with the owner. Do not run a duplicate of an existing session. A missing
poll may also mean a disconnected bridge; inspect before choosing recovery.

### Native seat transcript sync

`clankie seat-sync` consumes Claude or Codex hook JSON on stdin. The
`clankie claude`, `clankie codex`, and `clankie opencode` launchers set their selected
`CLANKIE_CONVERSATION_ID`. Claude supplies `CLANKIE_SEAT_SESSION_ID`; Codex’s trusted
hook supplies it from the captured native binding. OpenCode sends transcripts
through its per-launch bridge. Unlaunched plugin use and hooks for another session
are ignored. The plugin invokes sync at
session start/end, prompt submission, stop/failure and before compaction. Claude
and Codex also upload on asynchronous `PostToolUse` hooks, throttled to one
attempt per two seconds. Progress appears as tools finish; a long tool or a
text-only stretch waits for the next hook. Codex requires native hook review
again when its hook definitions change.

The CLI reads the matching native transcript locally, redacts display records,
and posts bounded message/tool batches to `/v1/seat/transcript` with the operator
credential. Each hook continues from the native fold the service last
acknowledged and sends only what the session appended since; that checkpoint
(`$TMPDIR/clankie-seat-transcript-<session>.json`, owner-only) holds native ids,
tool names and byte offsets, never transcript text. A missing, foreign or
outgrown checkpoint, a rewound session, and every `SessionStart` replay the
retained window once; the service deduplicates it. No host file path is read by the service. The session is pinned to its
conversation; retries and resume retain the same native entry identities. The
next hook retries retained records after a transport failure. The final page carries
`responding` at prompt submission or tool progress and `waiting` at session start/end or stop/failure;
the prompt submission also carries `turnStart: true`, while tool progress does
not. This start signal keeps late tool progress from invalidating a captured
Stop settlement. Older strict services receive one retry without the marker.
Compaction leaves activity unchanged. Empty transcripts still carry lifecycle
activity. These are display signals, not service-run completion or ownership. Reset retires that
conversation's native sessions; launch a new seat afterward so old history cannot
repopulate the cleared conversation. Sync failures never
instruct the harness to continue or block a stop. The current 9,000-entry display tail
is the replay bound. Image files use `clankie file publish` separately.

Remote Claude lead hooks use `/v1/fleet/lead/transcript` over their authenticated
fleet relay. They share a two-second upload deadline across every page, with no
in-hook retry backoff. Only acknowledged display entry IDs are checkpointed on
the native host, scoped to the session and destination; an interrupted upload
resumes its remaining records on the next hook. Losing the checkpoint causes a
safe replay. Each request consumes its body before one fresh native lifetime
proof and a synchronous store write; tool calls retain their own authority checks.
The PC's `~/.clankie/remote-leads/hooks.log` records hook and request durations,
plus `authMs` and `storeMs` from the service's `Server-Timing` header when available.
Authentication includes the fresh process proof. Compare those with request time
to distinguish service work from transport; the remainder also includes client
and body handling. Three consecutive failed hooks still report a warning.

A service restart interrupts an unanswered seat run with `failed` and
`reasonCode: service_restarted`; it does not prove that the independent native
seat stopped. Escalation reply waiters do not survive restart. A later `reply`
returns an explicit target-gone error instead of claiming the answer was sent.
An uncertain delivery remains fenced until its exact receipt is reconciled;
restarting or reconnecting never replays the request.

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

- `/setup` — explicit autonomy level → first-run sign-in and model choice →
  phone sign-in and `/pair` →
  optional `/connect` → first agent's folder/task and a reviewed request through
  Clankie's normal conversation. An active phone with chat access is required
  to mark pairing complete; a minted QR is only an offer. `/setup rooms` opens
  the other settings checklist. Escape or `/cancel` stops the current step;
  re-entry reads live settings/device/roster state. `doctor --json`'s `captain` field is
  its headless model readiness
- `/auth` and `/connect` secret entry — provider keys, OAuth, Linear (MCP token
  and webhook signing secret), and email
- `/discord` secret entry and lab-user ToS opt-in — Discord tokens never become flags
- `/voice` — realtime/TTS provider and brokered credentials
- `/btw`, `/board`, `/jump`, `/conversation`, `/layout` — live console state

There is no `clankie up` or `clankie auth`. Local model
servers are not supervised.

### Where a provider key lives

`/auth anthropic` opens API-key entry directly. Clankie no longer offers Claude
subscription login or refresh; replace any legacy token with an Anthropic API
key (or remove it through `/auth`). Doctor/setup do not count that legacy OAuth
entry as usable authentication. Self-hosted native Claude Code and Codex retain
their own login, and [`clankie claude`](#seat-commands) seats Clankie in Claude
Code on that login.

Managed Clankie uses AI credits only. Model and native subscription sign-in,
customer-key entry and customer-model selection are refused with an explanatory
message. Local Claude/Codex hires are also refused until a credit-backed native
adapter exists; hire those harnesses on linked self-hosted hardware instead.
Local/self-hosted ChatGPT sign-in and supported API-key model paths remain
available. Existing credential stores are preserved. See
[ADR 0239](adr/0239-worker-harnesses-sign-in-with-their-own-logins.md).

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
control. Local lifecycle, autostart, sockets, native harness commands
(`claude[N]`, `codex[N]`, `opencode`), `mcp` and shell escapes refuse in hosted mode.

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

`clankie opencode --conversation ID --dry-run` reviews the native
launch, installed version, skill selection and required owner steps. Remove
`--dry-run` to launch; `--resume` uses the exact recorded session and chat.
Without `--conversation ID`, a fresh launch takes the global chat while no live
seat holds it and otherwise (or with `--new`) creates a separate workspace chat;
dry-run creates none. `/opencode`
in the console reviews the same plan. Installation, per-launch settings,
removal, native delivery semantics and current verification limits are in the
[OpenCode seat guide](../integrations/opencode-plugin/README.md).

### Grok Build worker and operator seats

`clankie grok --dry-run` reviews the
native launch, profile, selected skills and conversation. Remove `--dry-run`
to open the interactive Grok Build TUI. This adapter requires macOS and Grok
Build 1.0.46 or newer on PATH, an existing Grok sign-in, and Clankie's operator
credential. Each connection probes the leader IPC and ACP; a release that lacks
them is refused with its version and what is missing. It uses the current `GROK_HOME` (otherwise `~/.grok`); it never
changes accounts or signs in. `/grok` reviews the same plan in the console.

A fresh launch takes the global chat while no live seat holds it and otherwise
(or with `--new`) creates a separate workspace chat. `--conversation ID`
selects an existing conversation; `--resume` retains its exact native session,
profile and chat after a confirmed exit. An uncertain prior exit or delivery
refuses another launch until the original TUI and receipts are inspected.
`--plugin-dir` and numbered account commands are unsupported. Persona and the
memory card come from the selected service conversation; selected skills are
provided as paths to their `SKILL.md` files. Native transcripts and service wakes
follow that conversation through the existing operator API/outbox.

`hire_agent` with `harness: "grok"` creates a visible worker in its named repo grid.
The brief and `message_seat` follow-ups use leader IPC/ACP on that exact TUI
session. Explicit model/effort choices must match the native registry; unavailable
choices refuse. The worker gets the fleet meta tools and `message_clankie`.
Queue consumption is a delivery receipt, not a completed reply. A saved Grok
transcript without its original live controller cannot be resumed as a hire.
New Grok panes can join the named grid; control adoption after a service restart is unsupported.

Native permissions remain owner decisions. Grok leader mode ignores CLI
`--allow`/`--deny`; this launcher does not claim they isolate tools. An observed
enabled direct Linear MCP endpoint refuses before the worker brief: disable it
in that Grok profile and start a fresh seat. A missing native catalog, changed
session or process, unavailable sign-in, or uncertain acknowledgment retains
the original evidence and names the refusal; no headless or terminal-input
fallback runs. See [ADR 0224](adr/0224-grok-build-shares-the-visible-native-session.md).

### Prime Agent operator seat

`clankie prime-agent --dry-run` (alias `clankie prime`) reviews the launch: the `prime-agent` install and daemon socket, folder, conversation
and skills. Remove `--dry-run` to open it. It needs Prime Agent 0.10.x on PATH
(daemon protocol 7), a model sign-in in Prime Agent, and Clankie's operator
credential. `--model PROVIDER/MODEL` picks the new session's model; otherwise
Prime's own default applies. `/prime` reviews the same plan in the console.

The seat is a resident session in the owner's Prime Agent daemon. `create`
loads the service persona and memory card through `appendSystemPrompt` and
the shipped skills through `skills`, and passes this pane's `HERDR_*`
variables so Prime's own Herdr reporter binds the pane. Nothing in
`~/.prime/agent` is edited. `replace_acp_mcp_servers` adds the operator bank
as the session's `clankie` MCP server; the model calls it from its REPL with
`mcp.call_tool("clankie", ...)`. The terminal then runs `prime-agent attach` on
that exact session. Closing the TUI only detaches: the session stays resident
and its MCP server stays loaded, but wakes stop until `clankie prime --resume`.

Wakes, watches, worker messages and room escalations arrive through the
daemon's `prompt` on the recorded session, never terminal input, so an unsent
draft in the TUI is kept. An idle session starts a turn at once. A busy one
queues `wake`, `watch` and `message` events behind the running turn and steers
owner turns and escalations into it. Each event is fenced before it is sent;
a failed or unanswered send is never resent and blocks the next launch until
the receipt under `~/.local/state/clankie/prime-seat-receipts/` is inspected.
Native transcript turns and tool results project into the selected chat.
Diagnostics go to `seat.log` beside the receipts, not over the TUI.

`--resume` reattaches the recorded session if the daemon still hosts it with
the same session ID, else reopens the recorded session file; any other session
refuses. It also refuses after an unconfirmed exit, a changed daemon socket or
a changed conversation. `--plugin-dir` is unsupported.

Prime Agent asks no tool approvals by default; its own settings govern what
runs. The operator bridge's parent is Prime's Python kernel, which also runs
model code, so the seat hands the bridge `CLANKIE_OPERATOR_TOKEN` explicitly.
Prime keeps that server list in worker memory only, but code in the same
session can read it back. The server list is lost if the worker restarts;
`--resume` reapplies it. See [ADR 0263](adr/0262-prime-agent-operator-seat-is-a-resident-daemon-session.md).

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

### `conversations head OWNER HEAD|none`

Set or remove an explicit escalation head using operator authentication:

```sh
clankie conversations head ROOM_OR_CONVERSATION_ID HEAD_CONVERSATION_ID
clankie conversations head ROOM_OR_CONVERSATION_ID none
```

Use the existing conversation listing to select exact IDs. The owner can be a
host-created room; the head must be a writable global/workspace conversation.
The TUI command `/conversation head HEAD|none` applies to the selected thread.
`POST /v1/conversation-heads` accepts only `{conversationId,headConversationId}`,
where `null` removes the designation. Observe and captain credentials cannot
change it. Self references and cycles are refused; there is no default head.

Explicit asks and asynchronous results try the owner first and may use its head
only after a definite refusal before acceptance. Revoked source authority or
presence, a changed designation, and uncertain dispatch cannot trigger fallback.
This forwards the explicit request/result only and grants no room privileges.

Discord room inspection, private next-turn guidance, delivery health and exact-stay voice controls are documented in [Discord rooms](discord-rooms.md). Use `clankie discord rooms`, `clankie discord guide CONVERSATION_ID TEXT`, and `clankie discord call`. Doctor and call status report listener-provider readiness before a join: a bounded, five-minute cached admission check with no audio or response generation; `credit_balance_exhausted` outranks unrelated seat warnings. Listener readiness does not prove that a full call can hear and answer.

### Project workspace removal

`clankie project remove-workspace NAME --workspace PATH` removes the exact owner
registration, including a folder that no longer exists. It preserves project
policy, grants and assignments and refuses to orphan a tracker binding.
Both `project add` and `project remove-workspace` accept
`--machine ID --platform windows|posix` for an explicit remote registration.
Remote paths are normalized absolute paths on that machine; registration does not
replace live native process/canonical filesystem proof or grant any tools.
The owner API exposes `GET /v1/operator/projects` and revision-guarded
`POST /v1/operator/projects/remove-workspace` (`projectId`, `workspaceId`,
`expectedRevision`).

### Signing worker harnesses in

`clankie harness login [status | accounts | claude|codex [--add [LABEL] | --profile LABEL] | remove claude|codex LABEL [--yes] | cancel SESSION_ID]` signs the
Claude Code or Codex worker harness into the owner's own account with that
harness's official login on self-hosted bodies ([ADR 0239](adr/0239-worker-harnesses-sign-in-with-their-own-logins.md)).
Managed bodies return an empty harness list and refuse login with
`managed_credits_only` and an explanatory message; use AI credits there.
On self-hosted bodies, `status` prints JSON for both harnesses (`installed`, `signedIn`, `method`).
`codex` prints a link and one-time code on stderr and waits for the device
sign-in; `claude` prints the authorization link and prompts for the code the
page shows (it needs a terminal; a wrong code prompts again). Stdout gets only
the final JSON, without the link or code; exit 0 means `complete`. Ctrl-C
cancels on the service. `accounts` lists every account per harness (email,
plan, sign-in state, usage). `--add [LABEL]` signs a new account into a fresh
`~/.claude-LABEL` or `~/.codex-LABEL` profile and never an existing home;
`--profile LABEL` re-signs that profile. `remove` signs a profile out with the
harness's own logout and deletes it only if Clankie created it; it asks for
confirmation unless `--yes`, and refuses the default home. TUI: `/harness-login`. API and states:
[harness sign-in](harness-logins.md).

### Linking native fleet harnesses

`clankie harness install [--refresh-linked | --codex-source-setup /absolute/script] [--project PROJECT] [--approve]`
reads the current effective `machineSetup` policy and existing local link through
the authenticated service. Under `lead`, it runs without a terminal or another
approval on an already-linked machine. New setup is limited to the caller's
existing `CLAUDE_CONFIG_DIR` (otherwise `~/.claude`) and `CODEX_HOME` (otherwise
`~/.codex`); sibling Claude account profiles are skipped. Under `owner`, use an
interactive terminal for per-profile consent or supply the owner's explicit
`--approve` and confirm in an interactive terminal for the selected profiles.
Headless `--approve` is refused. Declining consent changes no registration.

`clankie harness install --refresh-linked [--project PROJECT] [--approve]`
maintains existing links and returns JSON receipts with a failing exit code for
incomplete installations. It includes remembered custom profiles and registered
Codex account homes; enabled fleet aliases sharing one SSH destination refresh
once. The CLI rechecks current project policy and target linkage before each
profile or remote destination. Under `owner`, refresh requires the owner's
interactive confirmation with `--approve`; under `lead`, automatic refresh requires an already-linked
target. Unlinked profiles and existing Claude channel policy stay unchanged.
Before the machine's first service start there is no operator credential and
nothing linked: refresh changes nothing and returns
`{"ok":true,"skipped":"service-not-started"}`, so a fresh install succeeds.
A source-managed Codex profile without a matching recorded source hook reports
`source-manager-required`: `source-managed: needs setup in <home>`. Doctor reports
the configuration owner and the source setup command. `clankie update status`
retains `harnessRefresh.ok: false`, reports `harness-refresh-source-managed` and
lists local/remote homes in `harnessRefresh.sourceManaged`; the complete receipt
still lists other refusals, including unlinked machines. These are installation
observations, not proof that an active thread adopted new tools. Have the source
owner provide a script and run `clankie harness install --codex-source-setup
/absolute/source-owned/script --approve` in that profile; preserve its config link.

An explicitly disabled Codex plugin reports `declined`: its native installer
would enable it, so refreshing that profile requires a reviewed install.
Checkout and release installers maintain existing links as part of the
owner-authorized update, then offer new linking interactively.

Native clients reporting an older worker version receive a durable, display-only
`clankie-plugin` pane flag with a save/restart/resume prompt, once per native
occupant/process and expected version. No harness or pane is restarted. The flag
clears when a current native client connects. A release installer announces its
worker version to an already-running service; unavailable notification is
reported as `notices.state: deferred` until the updated service connects.
The operator API exposes `POST /v1/harness-refresh` for the same maintenance,
with a required `workingDirectory`, optional matching `projectId`, and
`ownerApproved: true` for caller-reported owner approval. Its receipt marks this
as `ownerApproval: "claimed"`; the server cannot verify human confirmation.
It checks current policy,
workspace membership, target linkage and operator authority before setup.
It exposes
`POST /v1/harness-plugin-version` with `{ "version": "0.6.2" }` for that announcement.

Codex uses the native `clankie-worker@clankie-fleet` plugin for project-scoped
bridge tools and packaged skills. It does not load the operator-seat plugin.
Symlinked or marked generated Codex configuration is not rewritten. Use the
owning source/setup; `--codex-source-setup /absolute/script` runs an explicitly
selected source setup and checks that the link is preserved. A new source setup
always needs interactive owner consent, including under `lead`; automatic setup
may use the native plugin manager or an exact, already-remembered source setup.
Setup completion still needs doctor verification; no hook trust record is written.
Successful owner-approved source setup is remembered for that exact config
source and profile, so subsequent updates reuse it. A changed config source or a
legacy bridge without a recorded source setup reports `source-manager-required`;
select the source-owned script through the supported install/prepare command first.

`clankie herdr prepare NAME [--codex-source-setup ABSOLUTE_REMOTE_SCRIPT] [--project PROJECT] [--approve]`
(also `clankie runtime prepare`) prepares the configured remote machine. Under
`lead`, it needs an existing healthy link and no fresh approval; under `owner`,
the owner must review the setup and confirm `--approve` in an interactive
terminal. Headless self-approval is refused. A newly selected source setup script
requires the same owner confirmation under either policy. The CLI reads current
policy before dispatch, and the service independently checks policy, canonical
source workspace, project context and operator authentication again. The CLI
retains the named target revision across terminal confirmation and sends it to
the service; changing its SSH target or session refuses dispatch until reviewed.
An existing canonical workspace with no project uses global policy. Missing, ambiguous,
mismatched or unverified worktree context refuses.
It enables Claude in each discovered profile. An already enabled, installed Claude
profile whose settings symlink points to another discovered unmanaged profile
can update its own plugin cache without installing, enabling, or changing the
shared settings. Generated sources, disabled/missing plugins, and unknown targets
still require their source manager. Refusals include each profile's setup result.
Native enable's exact "already enabled at user scope" result (with the observed
Windows `×` or macOS `✘` marker) is successful only
when a fresh read of that same regular profile confirms the plugin is enabled;
other native errors still fail.
Preparation uses native plugin installation for
Codex, preserves managed Codex configuration, and compares installed Claude
versions with the service bundle. A source-managed Codex config needs the owning
setup script on that remote machine. Select it explicitly; Clankie never writes
through the config symlink:

```sh
clankie herdr prepare studio --codex-source-setup 'C:\Users\me\dotfiles\scripts\codex-worker-setup.py'
```

For owner mode or a new source setup, add `--approve` and confirm interactively.
The owner API
requires `workingDirectory` in the JSON body of
`POST /v1/runtime-connections/NAME/prepare`, accepts a matching `projectId`, and
uses `ownerApproved: true` only as a caller claim, shown as
`ownerApproval: "claimed"` in the receipt; it cannot verify a human confirmation.
Optional `expectedMachineRevision` binds the claim to the exact target revision
returned by the context route; the CLI always sends it. Without it, the claim
refers to the current named alias.
It accepts the same remote
script path as `codexSourceSetup`. Node (`.js`/`.mjs`),
Python (`.py`, Python 3.11+ for the dotfiles setup), Windows PowerShell (`.ps1`),
and directly executable source scripts run as argument vectors. The source hook
receives `CODEX_HOME`, `CLANKIE_CODEX_WORKER_MARKETPLACE`, and
`CLANKIE_CODEX_NATIVE_EXECUTABLE` for this approved installation. The dotfiles-owned
script uses a temporary regular config and the real native plugin cache, then
renders only worker selection into its own generated source, preserving unrelated
settings and the runtime link. No credentials are copied.

When Codex is installed, preparation fails with HTTP 409 and
`fleet_prepare_failed` if its worker version, activation, bridge, identity
forwarding or packaged skill is missing. The error names the missing checks and
native setup result; a legacy MCP registration cannot mark preparation complete.
An absent Codex executable remains an absent harness. After updating the owning
source setup and completing preparation, verify `clankie doctor --machine NAME`.
Do not restart unrelated panes; installation alone cannot prove a live receiver.
`clankie doctor` reports local profiles and
connected remote fleets, including their `linkState` and decoded failure reason.
The human `/doctor` checklist also shows each observed fleet link's state and
reason. `clankie doctor --machine NAME` inspects one registered fleet through
`GET /v1/runtime-connections/NAME/harnesses`,
`GET /v1/runtime-connections/NAME/membership`, and the connection inventory at
`GET /v1/runtime-connections`. Its `linkState` remains visible even when the
native harness diagnostics answer successfully. The membership card reads native
process and actual cwd observations for at most 64 panes, with two concurrent
inspections. It distinguishes missing proof, unsupported harnesses, pending
native sessions, stale hires, and project eligibility. Changed observations are
discarded. `nativeTools: "not-verified"` means the card has not tested that pane's
bridge socket, catalog or reply delivery; use a native tool call to verify those.
Doctor and roster additionally show `workerTools` for an authenticated served or
bridge-reported catalog: `pending`, `ready`, `missing`, `stalled`, or
`not-observed`, with the reason and observation time. An idle worker remains
ready; an unobserved catalog is unknown. Catalog reads do not erase a tool-call
timeout; a successful connected-tool call clears it. These diagnostics grant
no account, project or native peer authority.
Unregistered or disconnected machines never supply an arbitrary SSH target.

On Windows, Codex detection resolves a unique installed native executable from
PATH or the fixed npm package layouts, including the per-user npm root when SSH
omits it from PATH. It does not execute command shims or dotfiles launchers and
refuses ambiguous installations. Existing legacy Node bridge registrations remain
visible; no generated config rewrite is required merely to inspect them.

Reports separate executable presence, version, activation, bridge, hooks, and the
`clankie` skill. Static files never prove a live receiver or project membership.
OpenCode and Pi automatic plugin installation remains unsupported and appears
explicitly in doctor; use their native setup. Existing native sessions may retain
their loaded plugins; verify the actual catalog after setup. These setup commands
never restart the service or existing lanes. No launcher flags, project approvals, grants or owner credentials
are changed by linking a plugin.

Fleet plugin membership grants connected MCP tools, not operator CLI authority.
A native PC worker's fleet proof alone cannot call the operator setup/context
routes or supply a service-host canonical workspace. An authorized operator on
the service host can prepare its linked PC through the existing remote route;
no owner credentials are copied to make a worker's local CLI an operator.

### Repository-bound linked worktree roots

Enroll a dedicated directory for future linked worktrees of an already approved
repository with `clankie project add NAME --worktree-root ROOT --repo APPROVED_REPO`.
`--machine ID --platform windows|posix` selects a registered remote machine;
the service must observe that machine's real filesystem and Git state. The CLI
uses the owner API and does not treat a supplied path as filesystem evidence.

The root must exist at its exact canonical path. Filesystem roots, home/repository
ancestors, aliases, and namespaces overlapping another project are refused.
`APPROVED_REPO` must exactly match an existing workspace of the same project and
machine. Enrollment records its canonical Git common directory and grants no tools.

A native agent qualifies only when its actual canonical cwd lies in a real linked
worktree strictly inside that root. Clankie checks the linked Git admin directory
under the enrolled repository's `worktrees` metadata, the `.git` backlink, and the
repository's current `git worktree list`. A plain folder, copied `.git` pointer,
foreign repository, alias, or changed repository identity does not qualify. Missing
or invalid roots deny their own matches; unrelated registrations continue working.
A repository with more than 256 registered worktrees still admits a valid candidate;
sibling count does not confer or remove its project authority.

The authenticated `fleet status` working-preference lookup also proves the
repository of a linked worktree placed outside that repo's enrolled root, such
as an app worktree nested beside a core worktree. It uses the approved repo's
recorded Git identity, backlink and current registration to select project
policy. That lookup does not enroll the location for native agent membership;
the root requirement above still applies. Unknown, copied or ambiguous Git
identity refuses policy lookup inside an enrolled namespace.

Remove an enrollment with `clankie project remove-worktree-root NAME --worktree-root ROOT`
(and the same remote machine/platform flags if needed). Remove a repo's enrolled
roots before removing its ordinary workspace approval. Removal does not delete
worktrees, change repository files, or alter grants.

The owner endpoints are `POST /v1/operator/projects/add-worktree-root`
(`projectId`, `machineId`, `platform`, `path`, `repoPath`, `expectedRevision`) and
`POST /v1/operator/projects/remove-worktree-root`
(`projectId`, `rootId`, `expectedRevision`). Read the current revision from
`GET /v1/operator/projects`. Both writes recheck owner authority and settings
immediately before persistence; enrollment also re-observes the native root/repo.

### Present tense

`clankie status` and the TUI `/status` include the service's `presence` snapshot
when it answers. The operator `presence` read accepts a cursor and `waitMs` up
to 30000 ms; callers with the current cursor wait for a projected change. Mood
priority is needs_you, thinking, in_voice, playing, leading, idle. Thinking
includes background Discord captain turns. `activeSeats` and "Leading N workers"
count only workers with observed `working` status across local and remote fleets;
idle, resting, done, blocked and unknown seats are excluded. Optional
`nativeSubagents` counts only running native children of the live local Clankie
captain session, never workers or their children. It is absent when the parent
or transcript is unavailable, and zero when a readable parent has no running
children. Child and parent-session changes wake the presence poll independently
of fleet-seat changes. The oldest
unanswered owner ask appears as `pendingOwnerItem`, with the conversation
and question IDs needed to open it. `since` is a source start timestamp, or null
when that source has no known start. An unreachable service has no mood; clients
show that connection failure separately. The same read passes through the relay
and hosted paired-device authority seam.

The opt-in `includeFace: true` read adds an optional `face` field that drives
the desktop pet's screen independently of his
body animation. Its priority is `needs_you`, `error`, `new_message`, then
`working` (thinking or leading) or `voice` (in voice). An observed working
native captain or running native child also selects `working` without changing
the mood. Otherwise idle and play have no override. A newly committed captain reply in an owner conversation shows
`new_message` for ten seconds; a failed owner turn shows `error` (crossed `x_x`
eyes, independent of worker count) for thirty
seconds, or until that conversation completes a successful turn. Replayed
history, worker threads, Discord rooms and forks do not raise these faces.
The face and its expiry participate in the presence cursor. Reduce Motion
holds a distinct static face, and an unreachable pet uses his offline art.
Legacy reads omit the field. The desktop client retries without the opt-in
when an older service rejects it, checking again after one minute.

Desktop consumers may separately request `includeBeats: true`. Its optional
`beats` array contains only an ID, `hire` or `worker_report` kind, and source
timestamp; at most the latest completed hire and confirmed report accepted
within ten seconds. Quiet hours suppress them. Expiry changes the opted-in
cursor. Legacy requests omit the field and keep their existing cursor. A
resumed seat, failed hire or uncertain report never creates a beat. The desktop
client consumes IDs once and skips history and bursts; this metadata does not
contain worker output or identify a private conversation. See
[ADR 0220](adr/0220-clankie-has-one-present-tense.md).

## Computer body

```sh
clankie computer request '{"conversationId":"global-default","command":{"action":"status"}}'
clankie computer request '{"conversationId":"global-default","command":{"action":"acquire"}}'
clankie computer request '{"conversationId":"global-default","command":{"action":"inventory","leaseId":"LEASE_UUID"}}'
clankie computer request '{"conversationId":"global-default","command":{"action":"capture","leaseId":"LEASE_UUID","target":{"appId":"PID:123","windowId":"456"}}}'
clankie computer request '{"conversationId":"global-default","command":{"action":"frame","leaseId":"LEASE_UUID","screenshotId":"SCREENSHOT_UUID"}}' --image-path /tmp/clankie-frame-unique.png
clankie computer request '{"conversationId":"global-default","command":{"action":"input","leaseId":"LEASE_UUID","screenshotId":"SCREENSHOT_UUID","requestId":"REQUEST_UUID","inputs":[{"kind":"click","at":{"x":100,"y":80}}]}}'
```

Replace IDs with current receipts and a new UUID for each intended batch. The
command uses operator authority and `POST /v1/computer`, bound to the selected
runnable conversation. `frame --image-path NEW_PNG_PATH` saves a private PNG and prints its metadata;
read that image before deciding inputs. It refuses an existing destination.
Without the flag, `frame` returns base64 PNG media. Receipts
contain no pixels. Further actions are `renew` (`leaseId`, optional `ttlMs`),
`release` (`leaseId`), `revoke` (`leaseId`) and `recover` (operator stop-proof recovery). Never retry
uncertain input with a new request UUID. A busy body does not transfer ownership. `revoke` quarantines the current driver
even during an input batch; its next input refuses. Ordinary recovery needs host
stop proof. Local Mac recovery refusals include `detail` and `next` guidance.

For an **expired local macOS lease only**, the owner can explicitly accept unknown
Peekaboo native drain after confirming the old native driver has stopped:

```sh
clankie computer request '{"conversationId":"global-default","command":{"action":"recover","ownerRecovery":{"reason":"Old native driver stopped; owner accepts unresolved Peekaboo drain for this expired claim","expectedHolder":"global-default","expectedExpiresAt":1791837035456}}}'
```

Copy the holder and numeric expiry from current `status`; never reuse the example's
expiry. A nonempty reason (at most 2,000 characters), fresh same-operator authority,
an expired recovery claim, no service-tracked holder work and no computer operation
are required. The host records the reason, operator and original claimant in
`computer-recoveries.jsonl` beside its input journal and syncs it before release.
The audit records an authorized decision, not native stop proof or a successful
release. A `released` reply includes `recovery.kind: "owner_override"` and its
`auditId`; inspect status after transport loss. Stale expectations, active work,
changed authority or failed audit storage retain the lease. Native display idle
alone never authorizes recovery; this explicit owner decision accepts that
remaining uncertainty. Windows and joined screens refuse the override.

The service registers a macOS Peekaboo adapter. A native Windows Codex
`node_repl` can explicitly attach the Windows computer host; the
same command targets it through `CLANKIE_CONTROL_PLANE_URL` (loopback or an SSH
forward). Every attachment defaults to read-only, even with the full `sky`
client. An owner explicitly sets `allowInput: true` on the native host before
acquiring a new input lease. Lease and status record `allowInput`; status also
reports current `inputReady`. With that opt-in the full native client
supports coordinate click, type, key, scroll and drag, one primitive per capture.
Windows input requires `foreground: true` and `expect: {"field":"document_text","equals":"EXPECTED_RESULT"}`
(or `tree`, `focused_element`, `selected_text`): the observed field must change
to that exact value in a fresh same-window observation. Read the capture's
`accessibility` fields and its actual PNG before choosing the action.
Scroll also requires `at` in image pixels; its `amount` is a native logical-pixel
delta. Typing requires verified focus; clear-and-type and guessed element IDs
refuse. Dispatch or a changed PNG alone cannot confirm an effect. Windows
input rechecks host Win32 person activity before each dispatch, requires a two-second
quiet margin and refuses shell/system targets and system-switching shortcuts.
Any native error retires the host. Release remains gated on owner-run live
stop evidence; fixtures do not prove native interrupt behavior. Windows
setup is in [desktop control](desktop-control.md#windows-observation-host).
A host without an attached adapter returns `computer_body_unavailable`.
The attached native harness supplies its own app grants and turn stops; no second
reasoning loop starts. Hosted displays are not implemented. [Desktop control](desktop-control.md#shared-computer-body)
explains capture freshness, coordinate mapping and the provider's recovery
limitation.

## Activity shares

`clankie share [list | request JSON]` and `/share` control Activity shares on
the current connection. Local commands use the owner operator bearer; hosted
commands use the existing encrypted paired-device transport, including the
hosted console. Requests use `POST /v1/activity/shares`. The typed API client
exposes `activityShares(request)` with the same canonical request/response
schemas. Output retains the service's session and launch/stop receipt.

Share the current authorized game producer with `sourceId:"play"`:

```bash
clankie share request '{"action":"start","sourceId":"play","guildId":"GUILD_ID","channelId":"CHANNEL_ID"}'
clankie share list
```

For an image, first publish it through the existing conversation file contract;
the share request selects its exact conversation and artifact ID:

```bash
clankie file publish --conversation CONVERSATION_ID image.png
clankie share request '{"action":"image","conversationId":"CONVERSATION_ID","artifactId":"ARTIFACT_ID","guildId":"GUILD_ID","channelId":"CHANNEL_ID"}'
```

An existing delivered GIF, MP4, WAV or MP3 uses its registered artifact source ID:
`artifact:CONVERSATION_ID:ARTIFACT_ID`. GIF is an animation; MP4 is a finite demo.
PNG is also accepted through this source form. Files are checked against the
stored digest; animations/demos are bounded to 32 MiB and 120 seconds.

```bash
clankie share request '{"action":"start","sourceId":"artifact:CONVERSATION_ID:ARTIFACT_ID","guildId":"GUILD_ID","channelId":"CHANNEL_ID"}'
clankie share request '{"action":"switch","shareId":"SHARE_ID","generation":1,"sourceId":"play"}'
clankie share request '{"action":"switch","shareId":"SHARE_ID","generation":2,"conversationId":"CONVERSATION_ID","artifactId":"OTHER_ARTIFACT_ID"}'
clankie share request '{"action":"stop","shareId":"SHARE_ID","generation":3}'
```

IDs above are placeholders; guild/channel IDs must be Discord snowflakes.
A switch chooses exactly one registered source or conversation/artifact pair.
No source URL, filesystem path or capture permission is accepted. The service
assigns tenant/installation scope and checks destination authority. Start/image
accept optional `ttlMs` (default 30 minutes, at most two hours). Start and switch
return `{session,receipt?}`, list returns `{sessions}`, and stop returns
`{stopped:true,receipt?}`. Use the returned generation on later controls.

A hosted launch/stop receipt reports `outcome:"confirmed"|"refused"|"uncertain"`,
a request-bound `receiptId`, its exact session, and an invite URL when confirmed.
An unavailable or lost external reply stays uncertain. Commands never replay an
uncertain effect; use list and the receipt to reconcile before deciding another
action. Self-hosted sessions without a configured official launch adapter can
stream media but do not claim a Discord launch receipt.

The official hosted viewer performs Discord's SDK ready/authorize/authenticate
handshake and obtains scoped admission from the server. SDK query parameters and
URL fragments do not choose a tenant or room. Admission/configuration failure
opens no media socket; there is no anonymous legacy fallback. Audience access is
revalidated during viewing and revocation is terminal. Hosted customers do not
configure applications, bot credentials or tunnels.

For local self-hosted delegated viewing, `action:"grant"` returns
`{grant,expiresAt}`. On the configured viewer origin use
`/#share=SHARE_ID&grant=GRANT`; keep the read-only grant in the fragment and never
put an operator/producer bearer in a viewer URL. Grants are delegated access,
not proof of Discord membership, and expire for existing viewers too after at
most five minutes. Switch clears media/text/audio, advances generation and
revokes old grants for later joins; current viewers follow until their original
grant expires. Stop, share expiry or producer loss is terminal. Private scoped
media never appears on the self-hosted public legacy stream.

See [Activity sharing](activity.md) and the
[wire reference](../apps/discord-activity/README.md#scoped-general-media-core).

### Owner checkout freshness

`clankie checkouts status` reports each registered local owner's checkout:
branch, HEAD, cached `origin/main`, ahead/behind, dirty state, linked/stale
worktree counts, and `unreconciled` linked worktrees: commits not on
`origin/main` by content (`git cherry`, so rebased work counts as landed) or
uncommitted files, with owner (live pane, else the worker closed from it), age
since last commit or edit, and any recorded decision, oldest first. Managed
runtime trees are skipped. Doctor and local roster cards include these observations.
Cached refs are explicitly identified; status never fetches or edits a checkout.
Roster/fleet requests opt into checkout cards with `includeCheckouts: true`;
these describe each local worker’s actual Git root, including a linked worktree
or a session started below that root, rather than the primary checkout. Different
worktrees retain their own branch, HEAD, ahead/behind counts and dirty state.
older callers keep their original response shape and perform no checkout Git
observation. Opted-in reads cache root discovery and inspection together for
30 seconds, retaining at most 128 cwd observations.

`clankie checkouts sync [--repository OWNER_CHECKOUT]` fetches `origin/main`
and fast-forwards an owner checkout on `main` only when it has no local commits
and no local edits overlapping incoming paths. Disjoint staged and unstaged
edits survive. A refusal lists blocking files with their modification age in
seconds. No stash, reset, rebase, force, or automatic commit is used. Confirmed
`clankie integrate` pushes run the same sync and retain its result in the batch;
updates targeting `origin/main` also run it and retain the result. The running
service observes shared `origin/main` refs every five seconds and
fetches once a minute to catch pushes from separate clones or machines. It syncs
registered local owner checkouts automatically on startup and after main advances.
Blocked syncs produce a structured log entry (`checkouts.auto_sync_blocked`) with
the blocking files and their age; repeated observations of the same blocker are
quiet. They never appear in the owner's chat (VUH-2586); `clankie doctor` names a
checkout left behind or unavailable, with its recovery step. Manual sync remains
available when the service is stopped or for immediate recovery. A blocked owner
checkout does not undo a successful push or prevent the fetched runtime from updating.

`clankie checkouts decide --repository OWNER_CHECKOUT --path WORKTREE
--decision worth_landing|safe_to_drop --reason TEXT` records a judgment of a
linked worktree's unlanded work at its current HEAD. Doctor and tidy show it; a
new commit invalidates it.

`clankie checkouts reclaim-caches --repository OWNER_CHECKOUT [--path WORKTREE]`
reclaims ignored package-manager `node_modules` and Rust `target` directories
bearing a valid `CACHEDIR.TAG` in registered local agent worktrees. Trees must
be clean and inactive for six hours; complete native process cwd and pane
inventories must show no live use. A pane left in a directory deleted under it
makes the pane inventory unknown, so the sweep refuses and names that path until
the pane closes. Main, managed runtime, locked and alias trees are protected. Missing or changing observations refuse cleanup. A sweep examines
at most 32 worktrees, checking every cache in each; a `cache_worktree_limit`
receipt names every deferred tree. The next full sweep resumes after the last tree
examined, wrapping round, so repeated sweeps cover every tree; `--path` continues
with one exact tree now and leaves that order alone.
Commits, source files, `.local` evidence and logs stay.
The owner-authenticated `POST /v1/checkouts/reclaim-caches` accepts `repository`
and optional `path`; tidy uses `reclaim_tidy_worktree_caches`. This is manual;
there is no automatic cache-deletion timer. Reinstall dependencies or rebuild
before using a reclaimed tree again.

Ignored-path output is bounded to 1 MiB before capture can overflow. A
`git_output_limit` receipt identifies the Git phase, tree and byte limit; truncated
output is never accepted as a complete inventory. The nested-repository check
reads small directory batches, follows no symlinks, and streams the complete inventory
without a total-entry quota. Depth stays limited to 40, with at most 41 open directory
handles and a cooperative 60-second scan budget checked between entries (filesystem
I/O can take longer). Depth and time refusals retain the cache intact. The complete
scan runs before and after renaming; incomplete observations never authorize deletion.
Workspace importer caches can use the root pnpm install marker and installed lockfile
snapshot when that snapshot names their canonical project. Root caches are removed
last. Unknown or changing install evidence stays `install_unverified` or is refused.

`clankie checkouts prune --repository OWNER_CHECKOUT --path WORKTREE` removes
one landed, clean, inactive linked worktree in an enrolled worktree root:
merged, on main by content, or decided `safe_to_drop` for that exact HEAD. A
decided drop keeps its commits under `refs/clankie/dropped-worktrees/SHA`. The
Tidy up skill uses the equivalent `prune_tidy_worktree` tool after preserving
its result. Repeat `--path` (API `paths`, up to 64) to prune a batch: one fetch
and one admission listing, deepest trees first, and a fresh check of each tree
before its removal. The result is `{ results }`. The service fetches main, rechecks
Git and every live local pane's cwd, foreground cwd and process cwd, then moves
ignored `.local` evidence into the store, which costs no new disk on the same
volume. On another volume it copies all but the regenerable content. Regenerable
installs and caches inside `.local` (`node_modules`, `.turbo`, `DerivedData`,
`.pnpm-store`, `.gradle`, `.next`, Rust `target` with a `CACHEDIR.TAG`) are
discarded and listed in `discarded`. A worktree registered inside `.local`
refuses with `nested_worktree: .local/PATH`; prune it first. A failed removal
reports `left`: `registered`, `directory`, and whether `evidence` was `restored`
to the intact tree or `kept` at `evidencePath`. The CLI waits up to 30 minutes
for a prune's answer instead of giving up at two. Main checkouts,
managed pinned/runtime/update namespaces, the running service checkout, locked,
dirty, unmerged, and live trees stay regardless of developer-root enrollment. Git
removal is never forced; local branches are deleted only if merged. Evidence
is retained under `worktree-evidence/` in Clankie’s configured state directory
(default `~/.clankie/captain/worktree-evidence/`). Under the fleet `autoTidy`
setting the service runs this same prune hourly for trees whose HEAD is in
`origin/main` and that have had no checkout activity for a day (see `fleet set`).

New local and SSH hires fetch and verify their start checkout on that machine.
A clean behind-only checkout, including detached HEAD, fast-forwards to fetched
`origin/main` after a fresh census confirms no live pane uses it (including
foreground cwd and symlink aliases). Ignored files are never overwritten.
Dirty or divergent checkouts, failed fetches and missing main refuse before launch.
Advancement also refuses managed runtimes or unavailable/live ownership checks. Clean topic
branches based on current main are valid. Non-Git workspaces remain usable for
other tasks; saved-session resumes keep the exact saved cwd.

SSH freshness refusals include the underlying Git, filesystem or census error.
A live-pane refusal names its checkout directory; an unresolvable pane directory
also blocks advancement. Preserve the checkout and inspect that pane before
retrying. Diagnostics are bounded and redact credential-shaped values and URLs.

A dirty-start refusal names up to 20 paths, including untracked directories.
Preserve those files and use a clean deliverable worktree from fetched
`origin/main`. Untracked scratch files still count as dirty.

Close and tidy also hold merge commits outside the destination's ancestry:
`git cherry` skips merges and cannot establish that their resolution work
landed. Land the merge or record an explicit reconciliation decision after
inspecting it. A decided prune keeps the commits under
`refs/clankie/dropped-worktrees/`.

### Lent computer selection

Pass `machineId: "join-UUID"` in the existing computer request to select that
registered computer explicitly. Omit it for the local body. Selection failure
never falls back to another screen:

```bash
clankie computer request '{"conversationId":"global-default","machineId":"join-UUID","command":{"action":"acquire"}}'
```

On the joining host, `join` / `join resume` must stay running with the authored
native helper available. A screen-level join approval permits asking; the local
owner confirms observation for each session and separately allows input. The
visible pet offers Stop. Only one accessibility press/text append or bounded
key/drag/scroll runs per fresh capture, with `foreground: true` and a changed
exact `expect` field. Navigation keys use the documented named allowlist; scroll
requires `at` and 1–10 ticks; drag stays within the captured window. Observer
acknowledgments never release a post-input lease; Stop leaves it held. Never retry unknown input under a new UUID. Stop
and recovery remain usable after reducing access; uncertain quiescence keeps
the host lease held. Mac/Windows live driving proof remains open. Setup and
limits: [lend a joined screen](desktop-control.md#lend-a-joined-screen).

Desktop parents can supervise `clankie join … --json` or `join resume --json`.
Stdout is newline-delimited `MachineJoinEventSchema`: `approval` contains the
secret approval `code` and `expiresAt`; `joined` contains `machineId`; `screen`
contains a matching command `id` and status `result`; `finished` contains the
channel state `left` or `revoked`. Keep the approval code out of logs and evidence.
`left` means the process stopped, not that registration was revoked. A revoked
join deletes its lease and retains a secret-free refusal so later seat launches
report `revoked` rather than falling back to a local operator. `clankie join leave`
clears that refusal; approving a new join replaces it.

Keep stdin open. It accepts only `MachineJoinLocalScreenCommandSchema`:
`{"id":"UUID","action":"screen_status"}` or `screen_stop`. Status and Stop
cannot grant consent or enable input. Invalid controls fence the screen; stdin
closure also permanently withholds screen policy for that supervised process.
The status result contains `available`, `busy`, `allowInput`,
`inputReady`, `outcome` (`status`, `released`, `held`, `unavailable`) and a nullable
lease with only `conversationId`, `expiresAt` and `state`. It contains no lease
token, screenshot or native observation. `available` means the owned helper is
running, not that permissions or consent have been granted. `held` and
`unavailable` are not successful release receipts.

`join status --json` is finite and reads local registration only: `{configured:
false}` or `{configured: true, machineId, origin}`. It does not prove screen
readiness. `join leave --json` is finite: it revokes the encrypted transport,
then deletes the local broker credential and reports `{ok: true, left: true}`.
A failure has a nonzero exit status; uncertain removal is never reported as
success. Revoke alone is not proof that an outstanding screen effect stopped.

`clankie machines access-refusals --json` reads durable access-level refusals
with the machine, selected and required levels, observation time and owner fix.
Doctor includes unresolved observations; an owner's sufficient access grant
removes them from the view. This read never raises machine authority.

`clankie machines shell-audit --json` (`GET /v1/machines/shell-audit`) lists
Clankie's recent joined-machine shell calls. Each record holds the lane, the
origin (`owner` or a refused `autonomous`), the conversation, machine, folder,
SHA-256 of the command, outcome and the exit code the joined machine reported.
`unknown` means the home stopped waiting, so the command may or may not have run.
Doctor shows the last 20 as `joinedShellAudit`. A record is synced before the
command is sent, and a call that cannot be recorded is refused. The audit stores
only the digest, but the full command text stays in that conversation's session
transcript. The digest is a convention, not secrecy.

### `fleet roster [retire SEAT OCCUPANT | undo HISTORY_ID]`

Read the owner's live fleet counts, grouped by working, waiting, idle and
finished, machine and lead. Each row includes its native occupant identity,
issue, last known progress and host-observed stale flag. `complete: false` and
`readWarnings` mean a source did not answer; those agents are unknown, not zero.
Unsupported native statuses have an explicit unknown count.

The CLI requests `?includeWork=true`. These reads add `project: {id, name} | null`,
`task: {issue, title} | null`, and `ownership: hired | owner | unowned` to each
agent. Project comes from the existing host-confirmed membership proof for that
exact occupant, never the pane title or its advertised working directory. Task
comes from the seat's explicit current assignment or assigned deliverable; a
free-text deliverable is unknown. No tracker request is made to fill these
fields. The roster has no cached issue-title source, so `task.title` is currently
`null`; an assignment objective is not an issue title. Missing, revoked, timed-out
or unsupported membership is `null`.

`hired` identifies a host-recorded hire, `owner` a hand-started pane subsequently
adopted by a conversation, and `unowned` a pane without an ownership claim. These
are display markers, not control grants. Existing counts still include all rows;
clients can use the markers to select their team count. Unadopted personal panes
remain `unowned`; the host cannot infer their purpose.

Unnegotiated `GET /v1/fleet/roster` retains the original strict v1 response shape
so existing app builds continue parsing it. The shared API client opts in; new
app/device-session consumers must request `?includeWork=true`. The new schema
also accepts older hosts that omit the three fields: omission means the host
does not supply this metadata, while explicit `null` means unknown.

Retire takes the exact seat and occupant IDs from that read. Only finished or
stale hires with nothing pending qualify. The existing `close_worker_pane`
implementation checks kept reports, unsent drafts, provenance, work and native
process identity. A refusal keeps the pane and returns its reason. There is no
force or unlanded-work override on this owner route. Undo takes the returned
history ID within its five-minute window and resumes the same native session.
Never retry a retire or Undo automatically after a lost response; inspect the
roster and close history first.

The CLI, API client and app use `GET /v1/fleet/roster`,
`POST /v1/fleet/roster/retire` and `POST /v1/fleet/roster/undo`. Reads and writes
require the operator or an owner-paired Take Control device. Worker, support and
visitor credentials do not grant access. See [ADR 0279](adr/0279-fleet-counts-come-from-the-host-roster.md).

### `fleet processes` / `fleet processes retire`

`clankie fleet processes` reads the local host's Codex, Claude and Codex helper
processes through the operator-authenticated `GET /v1/fleet/processes` API. Each
row includes PID, parent, kernel start receipt, executable, cwd, live pane/seat
owners and any original controller-created launch. `lastActivity` is the exact
native thread log's mtime where found, explicitly a proxy; otherwise it is null.
Neither that timestamp nor PPID 1 proves an orphan: dedicated Codex servers
intentionally survive service replacement.

`verified-closed-hire` requires the original native hire/owner, confirmed closure
of that same thread and pane, a complete current pane census, matching lossless
PID birth and original listener/socket proof, no reattached native client, and
fresh native idle status for every loaded thread. An empty loaded inventory is
accepted only when the original thread independently reads `notLoaded` with no
in-progress turn. Loaded descendants must trace back to that original thread;
an independent root refuses retirement. Unattributed processes, live
owners, old second-resolution receipts, uncertain closures and unavailable proof
remain `report-only`. No caller may pass a PID, broaden the scope or use age as
retirement authority.

`clankie fleet processes retire` calls `POST /v1/fleet/processes/retire` with an
empty object and returns the before report, individual outcomes and after report.
It rechecks those proofs and sends TERM to only each exact eligible server
lifetime. It never signals groups or escalates to KILL. A durable intent/exit
journal prevents replay after uncertain delivery, including service replacement.
An `exit_unconfirmed` outcome needs inspection rather than another signal.
Normal service recovery performs the same guarded sweep every five minutes.
Released controller launch records are retained separately for this check;
retained records alone confer no control or retirement authority.

This is local-host recovery. Remote/Windows harnesses and third-party processes
stay outside this command's termination scope. Inspect and report the list before
an initial live cleanup; retain processes whose ownership or inactivity cannot
be proved.

`clankie work project-details --repo REPO` reads the saved tracker project’s summary, description, status, priority, lead, dates, teams, resources and latest 200 authored status updates. The latest 20 updates each carry up to 200 `replies`, flattened oldest first with author, time and parent identity. Reads use at most four concurrent comment calls and one page per update. `replyCount` is a lower bound when `repliesTruncated` is true; a failed thread read omits its reply fields without hiding the project. These fields are optional for legacy-service compatibility. Replies use the existing `save_comment` tool with `statusUpdateId` (or `parentId` for a reply to a reply), through the same account and authorization as project comments. Paired devices use the additive `work_project_details` operation. Linear and the built-in tracker share the canonical project/status-update tools. Unsupported or failed reads answer unavailable; an empty feed means a successful read with no updates. The read never infers health, author or delivery from issue state.

Paired owner devices fetch evidence bytes with `evidence_fetch` (`sha256`, `offset`, `length`, at most 256 KiB). Responses contain base64 bytes, total size and the recorded content type; no service URL or signed link leaves the authenticated device/relay path. Unsupported storage backends answer unavailable. The relay forwards it as an owner route under the device's own identity (never the captain bearer) and passes the bytes through unredacted; unpaired, revoked or supervise-only devices are refused (VUH-1977).

### `work import linear --project UUID --scratch NAME`

Read-only import of a single-team Linear project through Clankie's broker-connected
app. The service stores the mirror under its `tracker-imports/NAME` directory,
separate from the live tracker, and writes `import-report.json` there. Names use
letters, digits, underscores and hyphens. No backend switch or deploy is implied.

The import includes archived issues, VUH identifiers, comments/replies, history,
labels/priorities, relations, project milestones, documents, updates and team
cycles. Authenticated Linear uploads enter the evidence store and links become
`clankie://evidence`. External links remain references and appear in the report.
The shared background request budget applies; a refusal includes its retry time.
Reruns upsert by provider UUID and do not change the tracker when the source is
unchanged. Multi-team project mappings are refused rather than guessed.
The report's `projects` lists each Linear project with its built-in tracker
project UUID (`trackerProjectId`); set that on the settings project with
`project update` to bind it.

### `work mirror linear --scratch NAME --project UUID enable|disable|status`

Keeps an imported scratch store current from Clankie's signed Linear webhooks
(Mirror 2). Nothing mirrors until the owner enables a store, and only a store
imported from that project can be enabled. Each accepted data-change event for
the project (issue create/update/state/priority/labels/milestone, comments,
labels, project, project updates, documents, cycles and issue attachments) goes
through the import's own mapper, once per Linear event id, attributed to the
original Linear actor on the item event stream and the sync journal. His own
writes' webhook echoes are mirrored too. Wakes are unaffected.

The mirror is read-only: built-in tool and sync writes to it are refused with
`mirror_read_only` until cutover. An event that references a record the mirror
lacks is drift: the service re-reads only that issue (or the project's milestones,
labels or updates) through the connected account within the background request
budget, applies it with the import mapper, and records the repair. Linear sends
no milestone or relation events, so project events refresh milestones and relation
changes arrive with the next re-read of an issue. `status` returns counters
(applied, duplicate, ignored, drift, failed), the applied event count and the
last 50 drift reports. The service keeps bindings in `tracker-imports/mirrors.json`.

### `work cutover linear --world-project ID --scratch NAME --project UUID [--dry-run]`

Mirror 3 (VUH-1987): the World project `ID` moves off Linear onto the built-in
tracker. Always run `--dry-run` first. It only reads, including a fresh read-only
capture of the Linear project through the connected account, and prints this plan:

- `counts` per type: `linear`, `builtIn`, `missing`, `extra` and `stale`;
- `mirror`: the webhook mirror's state, counters and unrepaired drift;
- `changes`: the mirror is disabled, the live `tracker/tracker.json` is replaced by
  the scratch import (with its storeId, counts and backup path), the settings
  project's `trackerProjectId` is set, and the convention file switches from
  `linear` to `builtin`; when the live store holds releases (derived from
  repository tags by `work releases sync`), a `releases` change says how many
  carry over into the promoted store;
- `refusals` and `warnings`;
- the exact `switchBack` command.

Without `--dry-run`, the cutover applies those steps in that order and records
them in `tracker/cutover/active.json`. A refused cutover returns the same plan
with HTTP 409 and changes nothing. It refuses when:

- the copy has drifted from Linear (missing or stale records);
- the mirror recorded failed events or unrepaired drift;
- the live store already holds authored records (anything but synced releases);
- the convention is not `linear`;
- another cutover is active.

After a cutover, the project's `.clankie/tracking.json` reads `backend: builtin`,
and its `linear` block stays unchanged for switch-back. `clankie work --repo`
and workers' `linear_*` calls with that project's `repo` then use the built-in
store, scoped to the bound project UUID. Clients see a new storeId and
rebootstrap. The scratch store itself is left unchanged.

### `work cutover linear --world-project ID --switch-back [--dry-run]`

Reverses the active cutover. The dry run prints the convention, binding and
store changes, and `pilotWrites`, the built-in writes made since cutover that
Linear does not have. The switch-back restores the convention's and the live
store's exact pre-cutover bytes and the previous binding. It keeps the pilot
store as `tracker/cutover/<time>/pilot-<time>.json`. The mirror stays disabled.
To cut over again, re-import into a new scratch name and cut over that import.

Switch-back is lossy for everything written during the pilot. The restored live
store is the pre-cutover one, so the project's issues leave the built-in tracker
altogether. Items created after the cutover (`LOCAL-TEAM-n`), and the pilot's
comments, events, bundles, runs and owner asks, survive only in the pilot file.
Nothing is written to Linear; port what matters by hand. A re-import then takes
Linear's state as it stands, including any Linear writes made after the cutover,
and never the pilot's. The VUH-1987 rehearsal on a scratch copy of the real
Clankie Work store shows both effects
([record](testing/2026-10-25-vuh-1987-switch-back/README.md)).

### Work tracker settings

`clankie fleet tracker` reads the default for new projects. `clankie project
settings PROJECT` includes the project's saved work tracker; `clankie fleet
status` includes the global default. To propose a change, pass a selection as JSON:

```sh
clankie fleet tracker '{"backend":"builtin"}'
clankie project settings PROJECT tracker '{"backend":"github","repo":"owner/repo"}'
```

These commands only preview. Apply the exact preview by adding
`--revision PREVIEW_REVISION`; project changes also require
`--confirm-retain-items`. Existing items remain in their original tracker.
Nothing is migrated or deleted; switching back makes the previous items
accessible again. A changed project, convention, workspace or connection
invalidates the preview. Review again rather than automatically retrying.

Selections are `{"backend":"builtin"}` (a separate built-in project is created
when needed), `{"backend":"linear","team":"TEAM","project":"PROJECT"}`,
`{"backend":"github","repo":"owner/repo"}`, or
`{"backend":"markdown","directory":"docs/tasks"}`. Built-in project overrides
may name an existing `projectId` UUID; global built-in defaults always create a
separate project. Linear's `project` is optional for team-wide work, preserving
existing team-only conventions; it may include an existing board `label`. Linear and GitHub
require their existing connected account; connect through Settings → Accounts
or `clankie connect`. Built-in and repo files need no account. The future Discord
forum is a view of the built-in tracker (VUH-2531), not a selectable backend yet.

All surfaces read `GET /v1/operator/work-tracker` (optional `?projectId=ID`) and
use `POST /v1/operator/work-tracker` with `action: preview|apply`,
optional `projectId`, and `selection` on preview/apply. Apply carries the preview's
`expectedRevision` and `confirmRetainItems: true` for projects. The response
reports the selection, default, source, connection status and item retention
policy. It is owner-only, including through the hosted encrypted bridge.
The default affects new projects without an existing saved convention; existing
repo conventions and owner-reviewed project proposals take precedence.
The TUI accepts the same review/apply arguments through `/fleet tracker` and
`/project settings PROJECT tracker`; `/fleet status` also shows the default.

### Read-only shipping status (VUH-2526)

`GET /v1/integrate/shipping` projects the same durable queue that
`clankie integrate status` reads. Owner operators and paired Take Control devices
can read it through the existing relay/device transport. It accepts no mutation.
Each batch supplies state, updated time, issue keys extracted from commit subjects,
short commit IDs, failed-check status, and its pending request count. Shared batch
members count once each. Recent terminal results are bounded to 30 across projects;
active requests remain visible. Paths, errors, command output and credentials stay
in the operator-only status response. Unknown issue keys remain unmapped; no title
or checkout-name guessing is used. Interrupted historical records require resubmit.
