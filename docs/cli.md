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
The console opens at the latest messages; scrolling up loads older retained
history in pages without moving the text you are reading. Live messages continue
to arrive while older history loads. This applies to local and hosted consoles.
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
| `doctor [--machine NAME]`                                                                                                     | Human summary; `--json` preserves the full card                                              |
| `health`, `status`, `restart`, `down`, `autostart …`, `awake`                                                                 | JSON                                                                                         |
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
| [Control Activity shares](#activity-shares)            | `share list`, `share request JSON`                      |
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

CPU above its threshold or slow health must persist for the sustained duration
before one alert goes to the native `global-default` conversation. Recovery
reports the incident duration. A persistent incident emits no repeated alert;
the cooldown bounds alarms for subsequent incidents. An unavailable native
delivery retries at most once a minute, and a retained uncertain native receipt
counts as accepted so it is not replayed. These observations create no service
model turn. Include incident and recovery evidence in the next Linear check-in.

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
bounded process observations for up to five seconds; doctor takes a fresh sample.

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
introspection endpoint and explicitly reports `unverified`; ask Clankie to hire
a managed Codex seat with `hire_agent` to get a verified catalog. This action
never recommends the shared daemon, whose pane identity inheritance can break
worker bridges. Native introspection for embedded Codex remains a follow-up.
Plugin hook/mod trust is required; an absent probe remains unverified.

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

### `update [--ref REF]` / `update status` / `update canary`

`clankie update` fetches `origin/main` and stages its exact commit. Named branches
(including `origin/BRANCH` and `refs/heads/BRANCH`) fetch that branch from origin;
failed fetches refuse the update without using a cached or local tip. Use a full
commit SHA, `HEAD`, or `refs/tags/TAG` for an explicit local target. The result
records `resolvedRef` and `newCommit`, with `older-than-current-pin` or
`diverged-from-current-pin` warnings when applicable. It installs dependencies
in an independent detached worktree and schedules a fixed helper in a separate
process group. The current
service must be running the exact pinned checkout. Dirty tracked or untracked
files in that checkout refuse the operation before any service stop.

The helper installs before stopping anything, rechecks the pin, stops through
the existing service supervisor, retains the previous worktree, activates the new
pin and restarts the pin-dependent services. The external activity tunnel stays
running under its current owner; an unowned tunnel cannot block the update. Failed new health checks trigger a
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
post-update canary observes it for five minutes. The default budgets are 10%
captain-process CPU (100% means one core) and 250 ms `/health` p95, sampled every
10 seconds. Health latency includes TCP setup and the complete response on a
fresh loopback HTTP connection. Its deploy hold blocks further updates and integration landings
during observation. A pass releases only that canary's hold. A regression or
missing health signal records a failed canary, retains the hold, names the
previous healthy commit, and attempts the runtime-health alert path. The new
pin keeps running; rollback requires an explicit owner decision. Alert status
distinguishes submitted, unavailable, and an uncertain claimed attempt.
Submitted means the native notification path accepted the attempt; it does not
claim a confirmed recipient receipt.

`clankie update canary` reads the policy and last canary. Configure the next
update with `--window-seconds N`, `--sample-seconds N`, `--cpu-percent N`, and
`--health-ms N`; omitted fields retain their values. Policy changes do not
change an in-flight observation. `/update` offers the same settings in the TUI.
A restart of the observed service starts a fresh full window for its new boot
identity; elapsed downtime never counts as healthy observation.

The service also schedules an in-place tool refresh for running workers. Local
managed Codex controllers keep their original thread and descendants, wait for
idle, update only the private Clankie transport revision with a native config
version check, and reload once. A lost mutation acknowledgment is held for
read-only reconciliation. No turn or uncertain report is replayed.

`clankie harness refresh-tools [--pane PANE]`, TUI `/refresh-tools [--pane PANE]`,
and the operator tool `refresh_worker_tools` request one or all observed seats.
The authenticated API is `POST /v1/fleet/worker-tool-refresh` with `{}` or
`{"paneId":"PANE"}`. Each result is `refreshed`, `skipped-busy`, or `failed`
with a reason. Busy requests remain pending under their original authority.
Roster `workerTools` and `/doctor` show observed/expected plugin versions and
whether the observed runtime revision is behind. Local Codex seats started on
worker plugins before 0.6.5 show **restart needed** instead of an in-place refresh
success. The staging command `clankie harness restart-tools --pane PANE` (TUI
`/restart-tools --pane PANE`) accepts canonical pane IDs only. It can take
`--report /absolute/report` for a completed result. The current production local
Codex adapter lacks verified native exit; an idle otherwise-eligible target
returns `native_exit_unavailable` before any close intent. Automatic restart is
unsupported. Owner native quit
and saved-thread resume are required until that capability is available.
The operator API is `POST /v1/fleet/worker-tool-restart` with
`{"paneId":"PANE","reportPath":"/absolute/report"}` (`reportPath` is optional).

Restart requires an idle seat, no draft, known lead ownership, saved results,
settled report receipts, and a verified native exit controller. It rechecks the
original occupant before exit, records the close, and resumes the same native
thread through the saved account and working directory. The result returns the
thread, history ID, and resumed seat ID. A missing exit/resume acknowledgment
stays held in tidy history; inspect it before retrying. Restart is an explicit
operator action, never automatic deployment recovery. Remote Codex and Claude
restarts are outside this command. These fields grant no access.

Known native busy state also holds deployment metadata publication until idle.
The current implementation cannot safely refresh remote Codex configurations
or recover their original controllers after a service restart. Claude supports
native list-change adoption for an already current bridge, but replacing old
imported bridge code remains unverified. OpenCode verifies the original native
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

Deploy holds also block runtime-update admission. `update status` includes holds
and holder presence. An operator may override explicitly with
`--override-hold UUID --actor NAME --reason TEXT` (repeat the hold flag for every
hold); the registry records the override and retains the hold. The API accepts
an `overrides` array of `{holdId, actor, reason}`. See [integration](integration.md).

Supported `clankie mcp` operator bridges reinitialize after an explicit
`unknown_session` rejection before tool admission and retry that rejected request
once. Concurrent requests share the new session; reconnect drains old HTTP clients
without closing another pending call. The refreshed tool list lets the same
attached seat inspect the result.

Protected `message_seat` and `hire_agent` calls receive a `deliveryId` or `hireId`
before dispatch, carried in MCP `_meta["clankie/seat-call"]`. The service persists
the scoped receipt before the native effect. A lost result returns typed
uncertainty with that original ID; reconnect never replays the pending action.
Use the read-only `reconcile_seat_call({deliveryId})` or
`reconcile_seat_call({hireId})` in the owning operator conversation to inspect its
original receipt, without sending again or launching a replacement. A settled
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
The host OS and configured SSH principal are trusted; a compromised host cannot
attest its own history. The journal covers service-authorized effects, not arbitrary
programs launched outside Clankie's controlled hire path. It adds no fleet tool,
worker authority, account setup or TUI setting.

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
the exact **native hire** UUID of the settled original, including when delivery
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

The native `hire_agent` tool accepts the same optional `freshIntent`. This adds
no account change, fleet alias or TUI setting. Exit 0 from the fresh CLI means
the service returned `spawned`; completion still needs the matching native event.

### `integrate`

```bash
clankie integrate CORE_SHA... [--app APP_SHA]... [--push] [--id UUID] [--no-wait]
clankie integrate status UUID
clankie integrate push UUID [--override-hold UUID --actor NAME --reason TEXT]
clankie integrate revert PASSED_BATCH_UUID [--push]
clankie integrate holds
clankie integrate hold --holder NAME --reason TEXT [--pane ID|--seat ID] [--id UUID]
clankie integrate release UUID --actor NAME --reason TEXT
```

An ordered approved batch composes on fresh origin in independent throwaway
core/app worktrees, performs real installs and full checks with private home,
state, credentials and package stores, and records tested HEAD and exit codes
durably. It only lands a clean exact HEAD with a recorded pass. Core lands first;
app rejection retains a partial record and retries skip already landed core.
Revert creates a new commit restoring a passed tree. Named holds block push and
deploy; explicit owner overrides name the hold, actor and reason and are audited.
Requires a local source-checkout service. See [integration](integration.md) for
evidence paths, isolation limits, uncertain sends and crash recovery.

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

On a self-hosted Mac, `--local-companion` writes a single-use offer to the
owner-private `~/.clankie/companion/companion-offer.json` (`CLANKIE_STATE`
overrides the root), for the locally installed companion to redeem. Output
contains only the handoff path. Re-running it reuses the active companion's
device identity; it cannot be combined with review offers. See
[the local companion handoff](local-companion.md) for the typed API and security
contract. Signed app distribution and the installer's call remain separate work.

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
priority. The fleet equivalent is `clankie_call({name, arguments, background: true})`.
Background markers do not grant authority or downgrade writes. Each logical
read gets its own admission and may finish its provider pages. For example:

```sh
printf '%s' '{"team":"VUH"}' | clankie linear read list_issues --json-stdin --background
```

Initial account setup and OAuth token endpoint calls are outside the connected
Linear request counter; GraphQL identity verification during a connected app's
credential refresh is counted.

### `linear status` / `linear follow on|off`

A verified Linear webhook stores a compact **External activity** message in one
ordinary Clankie chat. `linearWebhook.wakeConversationId` selects that chat;
`global-default`, the lead conversation, is the default. Open it with
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
alone does not prove this identity lookup succeeded. No connected-account
notification poll, separate inbox, read/ack protocol, or issue-owner route
participates in delivery.

A Comment webhook may carry only `issueId`, without an issue title. Missing
display context is filled from retained signed Issue history or a native
connected `get_issue` lookup bounded to one second. That read supplies the identifier/title only; signed
actor, resource and changes remain the authority for wake rules. If title lookup
is unavailable, the compact event says `Title unavailable` and keeps its signed
issue UUID and link rather than dropping the event.

| Following     | Chat history                   | Automatic model turns                  |
| ------------- | ------------------------------ | -------------------------------------- |
| Off (default) | Accepted events remain visible | None from incoming events              |
| On            | Accepted events remain visible | One coalesced wake for eligible events |

The default rules wake only for comments or mentions by James, identified by the
signed user email `volpestyle@gmail.com`. Other actors and other changes stay
quiet. The connected tracker account remains Clankie's and his fleet's publishing
identity; it does not become the human owner. Display names and notification
subtitles do not prove authorship. A wake supplies context, never new permission.
[ADR 0214](adr/0214-linear-wakes-require-attribution-and-rules.md) records the
attribution and routing decision.

`clankie linear follow on|off` applies live. Turning it off suppresses new and
queued event turns; an already-running turn can finish. Turning it on does not
replay passive history. `clankie linear status` reports `following`, `active`,
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
`PUT /v1/linear/follow` with `{ "following": true | false }`. Both report the
configured `wakeConversationId`; PUT without webhook prerequisites returns 409.
Changing the local switch does not change which events Linear sends.

#### `linear target show|set CONVERSATION_ID`

```sh
clankie linear target show
clankie linear target set global-default
```

The target is one non-secret setting, `linearWebhook.wakeConversationId`. Select
an existing ordinary global chat the owner can open; an attached native operator
seat can drive it. To use a new chat, create it with `/new` in the TUI, name it
Linear, and find its stable ID with `clankie conversations list` before setting
the target. `set` does not create a chat. The change applies live to new activity;
it does not move history or replay earlier events. The authenticated
API is `GET /v1/linear/target` and `PUT /v1/linear/target` with
`{ "conversationId": "global-default" }`.

#### `linear wake [show|set …]`

Bare `/linear` opens **Follow Linear**, including **Wake rules**. Rules live in
`linearWebhook.wake`. Clankie can inspect or change these non-secret settings
himself through the operator-only `linear_wake` tool or authenticated CLI;
following must still be active.

```sh
clankie linear wake show
clankie linear wake set --owner-user-emails volpestyle@gmail.com --actors owner
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
| `--owner-user-emails` | `ownerUserEmails`           | Signed owner user emails; default `volpestyle@gmail.com`  |
| `--actors`            | `actors`                    | Any of `owner`, `human`, `self`, `users`; default `owner` |
| `--user-ids`          | `userIds`                   | Exact IDs selected by `users`; initially empty            |
| `--types`             | `notificationTypes`         | Included activity types; empty allows all                 |
| `--exclude-types`     | `excludedNotificationTypes` | Exclusions always win; default `issueSubscribed`          |

The default included types are `issueNewComment`, `issueCommentMention`,
`issueMention`, `projectUpdateNewComment`, `projectUpdateMention`,
`initiativeUpdateNewComment`, `initiativeUpdateMention`, `documentNewComment`,
and `documentMention`. The existing VUH-1549 rule engine classifies signed
webhook activity using these types. A newly added Linear issue/profile/resource
link in signed `body`, `description`, or `content` counts as a mention.

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

- `clankie work` (or `work status`, `work discover`) reports the repo's signals,
  its recorded convention if any, and a `question` when discovery found more
  than one tracker or only a single `TODO.md`. Answer it once with `work init`.
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
- Work statuses are `backlog`, `todo`, `in_progress`, `in_review`, `done`, and
  `canceled`. Linear backlog/triage, GitHub `status: backlog`, and Markdown
  `status: backlog` stay distinct from todo. Items may carry a native milestone
  id/name; Markdown uses both `milestone_id` and `milestone_name` front matter.
  Device `work_items` requests opt into these facts with `statusVersion: 2`;
  older requests receive backlog as todo and omit the new milestone field.
  `work_project` uses the same registered repo ids and device authority as
  `work_items`. Metadata reads share connected-account snapshots and pagination,
  preserving the poller's provider budget.
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
  On a scoped Linear board, `--label` intersects the saved repo label along
  with status/owner filters; it does not replace the scope. `show ID` remains
  a direct known-item read. Board scope does not grant or restrict tool authority.
- `clankie work create TITLE [--summary S] [--owner NAME] [--criterion C]...
[--status S] [--priority 0..4]`.
- `clankie work update ID [--status S] [--owner NAME | --no-owner] [--title T]
[--priority 0..4] [--check N]... [--uncheck N]... [--add-criterion C]...`; criterion numbers are
  1-based and may be comma-separated.
- `clankie work close ID [--canceled]` sets `done` (or `canceled`).
- `clankie work attach ID --url URL --caption TEXT [--kind image|video|log|link]`
  appends evidence; the kind is inferred from the URL when omitted.

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

### `play guide TEXT --conversation CONVERSATION_ID`

Suggest an objective or approach to the live Pokémon mind. The authenticated
`POST /v1/embodiment/sessions/live/guide` accepts `{text, conversationId}` and
checks the selected conversation's play ownership again before queueing it.
Clankie can use `pokeagent_guide` from that conversation; the mind still chooses
its objective and actions. This does not start a sitting or affect another game.

### `rivals`

`rivals connect URL [--token-stdin]` / `disconnect` configure the Rivals Agent origin live; its
token is broker-owned under `rivals-agent` (`/auth rivals-agent`). `rivals status`
reads the current sitting. `rivals start autonomous|combat|disengage [NOTE]` starts
a bounded sitting. `rivals objective SESSION MODE [NOTE]`, `observe SESSION`,
`share SESSION [GUILD CHANNEL]`, and `stop SESSION` require its observed ID.
All return JSON; a refusal exits 1. `/rivals` exposes the same commands in the TUI.
Notes are context, not instructions the current scripted policy understands.
See [Rivals setup and verification](rivals.md).

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

| Flag                    | Value                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `--display-name`        | 1–64 characters                                                                          |
| `--aliases`             | Comma-separated names; `none` clears                                                     |
| `--character-notes`     | Up to 4,000 characters                                                                   |
| `--chattiness`          | `quiet`, `balanced`, or `chatty`; shapes Discord and stream rooms, not the operator lane |
| `--reply-policy`        | `addressed` or `all`                                                                     |
| `--live-message-window` | Whole number from 0 through 100                                                          |

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

<a id="fleet-resource-governor"></a>

### `heavy [--seat LABEL] -- COMMAND [ARGS...]` / `fleet resources` / `simulator`

`heavy` runs a local command inside the shared OS-account resource governor.
It preserves child arguments, exit status and signals. Keep installs, compilers,
test suites, builds and entire owned runtime lifetimes inside the wrapper, and
serialize multi-package compilers with `--workspace-concurrency=1`. Native local
hire briefs include this contract automatically. Nested verified commands reuse
the same permit; surviving descendants retain it after a wrapper exits.

`fleet resources` returns current capacity, pressure, holders and queue as JSON.
The operator fleet snapshot carries the cached `resources` field; the TUI
`/status` and `/doctor` show holders by seat label or actual PID. Sampling does
not run on `/health`. Resource metadata contains no arguments or credentials.

The owner sets `fleet.resources` with these flags or the TUI `/fleet resources`:

| Flag                                      | Default | Meaning                                                                             |
| ----------------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| `--heavy-slots auto` or `--heavy-slots N` | `auto`  | Shared capacity, 1–64; auto is min(floor(cores/8), floor(RAM GiB/24)), at least one |
| `--simulator-slots N`                     | `1`     | Simulator ceiling, 0–64; each consumes a shared slot                                |
| `--simulator-idle-seconds N`              | `600`   | Lease heartbeat timeout, 1–86400 seconds                                            |
| `--max-load-ratio N`                      | `1.5`   | Maximum load average per core, greater than zero and at most 16                     |
| `--minimum-free-memory-mb N`              | `4096`  | Minimum OS available memory, 0–1048576 MiB                                          |

CLI edits update the journal immediately; API edits are reconciled by the body
within its five-second refresh. High pressure delays queued heavy work and refuses
new local hires with a reason. Existing accepted agents keep running. Missing
Python 3, helper or pressure observations refuse resource admission while the
body remains available. The canonical registry is the OS user's
`~/.clankie/fleet-resources`; worker environment and settings-path overrides do
not create independent capacity. See the [shipped skill](../.agents/skills/fleet-resources/SKILL.md).

`simulator acquire JSON` accepts `seatId`, optional `fleet`, `deviceType` and
`runtime`. The host proves the current local seat and occupant, creates a new
device, records its exact UUID and boots it. `simulator touch JSON` and
`simulator release JSON` accept `seatId`, optional `fleet` and lease `id`.
`simulator status` lists receipts. The operator credential is required; native
occupant, process proof and binding fields are rejected as caller input.
Idle expiry or proven seat exit cleans up only the exact created device. External
booted devices count toward the ceiling. Unknown receipts remain held for review;
observer shutdown does not release them.

Owner HTTP routes are `GET /v1/operator/fleet-resources` and
`GET|POST /v1/operator/fleet-resources/simulators`. POST uses the same strict JSON
with `action: acquire|touch|release`, a 16 KiB limit and fresh authority checks
before native effects. Unavailable resource status is 503; rejected mutations
are 409. These routes retain the existing operator owner boundary.

The manual `pnpm check:resources -- --run` proof starts an isolated Captain and
service embedding plus ten bounded command processes. Run its whole lifetime
through the active fleet limiter. It checks a two-slot pool, actual queueing,
process cleanup, service CPU and 250 ms health p95. Its fixed ten-by-two-second
workload must finish within 30 seconds, with the empty-pool first start within
five seconds; these are fixture regression budgets. It runs no coding model or
CoreSimulator; the VUH-1706 release gate remains the worker-bridge load proof.
The command is excluded from `pnpm check` and push, PR and scheduled CI.

<a id="fleet-status-fleet-set-notes-text-size-size-models-mode-fleet-clear"></a>

### `fleet [status]` / `fleet set [--notes TEXT] [--size SIZE] [--models MODE] [--closure lead|owner] [--machine-setup lead|owner] [--commit lead|owner] [--push lead|owner] [--release lead|owner|time_rule --release-rule TEXT] [--verification review_and_seal|change_run_read] [--report-style TEXT] [--tools connected|off] [--peer-messages on|off] [--hire-profile FILE.json]` / `fleet clear`

Read, set, or clear how the owner wants work routed across the agents Clankie
leads — which harness is the workhorse, which one reviews, what never goes to
which (up to 4,000 characters of free text) — and the budget he sizes the fleet
to, plus work closure, machine setup, working preferences and the fleet connected-tool and peer-message switches. `set` takes any combination of the flags;
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
evidence, not a scheduler. `--verification review_and_seal` asks for independent
review, addressed findings and sealing the reviewed revision with evidence;
`change_run_read` (default) asks for focused checks and reading their results.
`--report-style TEXT` sets reporting guidance (default "Short and plain.").
Explicit task and integrator gates take precedence, and these preferences
grant no additional account, tool or workspace authority.

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

`--hire-profile FILE.json` retains the global launch defaults for harness, model,
effort, native subagents, delegation, account and placement. Project role defaults
and explicit per-hire choices keep their existing precedence.

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
can. The section carries the effective fleet size, model mode and autonomy policy
on machine-authorized lanes, including the default `lead` responsibilities.

JSON includes the global `fleet` projection and a separate workspace
`workingPreferences` report, with either available resolved values or an
unavailable detail. The TUI `/fleet` command opens the same editor (size, models,
connected tools, peer messages, closure, machine setup, working preferences, then notes)
and `/fleet status` prints the same values.

```bash
clankie fleet set --notes "codex is the workhorse. claude when it needs skills or long context. grok for a hostile read on work that already passed review. never codex on Swift."
clankie fleet set --size small --models efficient
clankie fleet set --peer-messages off
clankie fleet set --closure owner --machine-setup owner
clankie fleet set --commit lead --push lead --release owner
clankie fleet set --verification review_and_seal --report-style "Short and plain."
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

`clankie agents role ROLE --project PROJECT` edits a project hire profile through
its revision-bearing owner API. Set any of `--harness`, `--model`, `--effort`,
`--subagent-model`, `--subagent-effort`, `--delegation native-first|panes`,
`--account LABEL`, `--placement new-tab|split`, `--cap N` and `--naming TEXT`.
`inherit` clears one preference; omitted fields remain unchanged. The console's
`/agents roles` menu sets the same fields.

```sh
clankie agents role implementer --project clankie --harness codex --model "sol 6.1" --effort xhigh --subagent-model "sol 6.1" --subagent-effort medium --delegation native-first --placement new-tab
```

Explicit hire fields expressing the owner's words win over the role, then
`fleet.hire` defaults, then the harness default. Omit fields to inherit; a model
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
group unrelated repos. A workspace is created and named from the repo once,
with a separate root tab reserved as `Clankie`. Existing labels are preserved.
An unmarked hand-created workspace is reused only when all its observed pane
directories belong to that repo. Mixed legacy workspaces stay untouched.
Non-Git directories use their exact working directory instead.

`new-tab` is the normal placement: a solo worker gets a `Name · role` tab.
A deliberate pipeline supplies a per-hire `pipeline` name, for example
`"VUH-1550 design → implement → review"`. Its first hire opens that named tab;
later hires use `placement: "split"` with the same pipeline and split its last
stage, preserving focus. `split` without a pipeline refuses. A same-named tab
with unmarked panes refuses instead of appending to an unrelated lane. Pipeline
names belong to the hire, not a blanket role or fleet default. Prepared
initial-command Pi/OpenCode/Grok hires can create the first pipeline tab but cannot
yet split into an existing one; they refuse rather than rebuild it.

This policy allocates new panes only. Resuming an already live native session
keeps its existing pane; a saved-session resume that needs a new pane uses the
same repo/tab rule. An explicitly requested move re-hires in a solo tab at the destination,
carrying its human name and known role; there is no automatic migration, rename or cleanup of older
workspaces, tabs or panes. The protocol `spawn_seat` request and `hire_agent`
accept the same optional `pipeline` field alongside `placement`.
Local Codex accounts use the registered account labels and homes; local Claude
accounts use `claudeAccounts` entries (`{label, home}`) plus the implicit
`default` profile. The owner registers their existing alternate directory with
`clankie accounts claude add /absolute/config/home --label second` (also
`/accounts claude` in the console); no login or profile path is guessed. Remote
account overrides remain unsupported. Profile selection confers no grants.

`clankie fleet set --hire-profile FILE.json` sets fleet hire defaults with the
same profile keys (`subagents` is `{model, effort}`); `fleet status` includes the
defaults and effective project role profiles. The hire result's `profile` shows
the effective launch preferences. These settings affect new hires, not running
agents. James's global agent instructions remain owner-authored.

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

`clankie agents efficiency --conversation ID` returns `{ conversationId, seats }`
for every seat that conversation leads, including linked fleets. Each existing
roster seat may carry `efficiency`: observed assignment, native model and effort,
context occupancy, progress and reporting evidence, and plain-text `flags`.
Context percentage is the latest native Codex model-input snapshot and may age
between responses. Claude context/effort and OpenCode or remote telemetry remain
unknown. Original report acceptance or a reporting attempt remains progress after
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
`done`), `deliverable` (1–512 trimmed characters), and `progressAt` (a UTC ISO
8601 timestamp for the substantive finding or commit). The CLI supplies the
action, seat ID and conversation; extra JSON keys are refused. A review applies
to that exact owned native session and records inspected evidence. It does not
change tracker state, harness settings, ownership or report receipts.

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
dirty or unmerged worktrees, and directories occupied by any observed local pane,
including idle agents and shells. Unknown or changing pane inventory returns
`outcome: "unavailable"` with no candidates. The command does not fetch refs or
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

What crosses the link, and what cannot:

- Every call runs `herdr --session SESSION <verb> …` on the remote host with an
  exact argv (a Windows command line is built for `CommandLineToArgvW` and
  handed to `ProcessStartInfo`, so PowerShell never parses it). One multiplexed
  ssh connection per fleet carries them through service-owned control sockets
  under `~/.clankie/ssh/` (`ControlPersist=600`). New service lifetimes and
  connections older than ten minutes use a fresh socket. A failure before the
  remote program starts retries once with a fresh login environment; failures
  from an already running program are reported without replaying the command.
  Resident fleet relays also refresh every ten minutes: the replacement becomes
  ready before the old relay drains accepted requests and proof commands, so
  routine renewal keeps link status ready. Retired masters retain
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

### `conversations list | show ID | tail ID | goal ID`

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
clankie conversations goal global-default accept
clankie conversations goal global-default set --tokens 1000000 "Finish the checked task"
clankie conversations goal global-default pause
clankie conversations goal global-default resume
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
original receipt remains and the request is never replayed. Earlier effects may
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

### `prompt [--lane LANE] [--sections identity,persona,reach,fleet,address,model] [--conversation ID] [--harness claude]`

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
| `fleet`    | Current fleet budget, effective project closure and machine setup responsibility, and optional routing notes; machine-holding lanes                                                                        |
| `address`  | His own mailbox, when one is connected                                                                                                                                                                     |
| `model`    | The card naming the model the service lanes run on (ask for it by name)                                                                                                                                    |

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

### `metrics --fleet`

Read operator-only `GET /v1/fleet/metrics` for proof attempts and refusals, worker
report attempts and failures, and fixed native/transport reason counters. The
five- and sixty-minute windows show failure fractions and failures per minute;
counters contain no process IDs, paths, argv, report bodies or credentials.
Doctor includes the same windows. A live seat with more than 1% terminal proof
refusals in five minutes produces a native alert to its current owning lead,
with a five-minute cooldown; native retries are counted separately from terminal
refusals. Metrics restart with the service and state their coverage start.

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

### `skills [opinionated on|off | exclude NAME | include NAME]`

The selected `tidy` skill exposes `/tidy` in the console. It starts an ordinary
visible, stoppable Clankie turn to inspect, harvest and close finished hired
panes with reasons. Output and saved reports remain in roster history, with a
five-minute reopen/resume Undo. Optional context can be passed as
`/tidy selection=w1:p1`. See [bundled skill declarations](bundled-skills.md#quick-action-declarations).

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
has the same controls in `/skills` and `/setup rooms` → Working skills.

Changes apply to new service sessions, local hires and Claude seats; existing
context is not erased. Reset a service conversation or start a fresh seat after
changing the selection, and reopen the console for its initial autocomplete.
No service restart is needed for selection changes once this code is running.

Existing service conversations discover added, changed or removed skill files and
workspace instructions before their next turn, keeping their history and selected
skill exclusions. Native seats keep their harness's own resource-loading behavior.

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
and a direct native **1.18.18** executable. Optional models use `provider/model`;
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
3, Herdr, native OpenCode 1.18.18 and its existing Clankie fleet link. Windows is
unsupported. Remote live acceptance remains open; [fixture evidence and limits](testing/2026-10-05-remote-opencode/README.md).

Every hire logs its selected lane and reason. The result carries `control.mode`:
`channel` for the Claude worker channel, `adapter` for Codex or OpenCode,
`terminal` for an unbriefed native launch, or `unavailable` with `control.reason`
explaining missing structured control. Registered remote fleets do not change the control lane of a
local hire. Native questions remain visible in the pane; approvals and
folder-trust prompts remain owner decisions.

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
is checked again after the final observation, with a 250 ms deadline immediately
before sending. A timeout reports undelivered and never sends on late approval. Private, changed
or unproved homes refuse the fallback; a private native receipt cannot authorize
a second send through CLI.
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

<a id="seat-commands"></a>

### `claude[N] | codex[N] | opencode [--resume] [--conversation ID] [--plugin-dir PATH] [--dry-run]`

Open Clankie in the selected native harness ([ADR 0152](adr/0152-a-harness-takes-the-operator-seat.md)).
`clankie claude` opens this seat with `claude`; `clankie claude2` uses your
`claude2` account command. Numbered Claude commands are resolved through your interactive
`$SHELL`, including shell aliases and functions. The same seat flags work with
either command. Each numbered command keeps its own resume record. `clankie codex` and `clankie opencode` open the corresponding native harness with the same flags.

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
session, and enables `clankie@inline` with the development channel flag for that
same identity. This also prevents a stale marketplace copy from restoring pruned
or disabled skills. Keep any marketplace seat plugin disabled globally, since
its forced output style makes every session answer as him when enabled there.
With `--conversation global-default`, inside the service's herdr fleet it names
that pane `clankie` once Claude Code
is detected there, which binds the pane to his own persona rather than a fleet
contact; a second pane claiming the name stays an ordinary fleet agent and is
told so on stderr. The pane is un-named again when the session ends.

Every fresh Claude launch starts a new Claude Code session under a recorded id and creates
a separate workspace chat through `POST /v1/captain/seat-context`, rooted at the
launch directory. Multiple launches in the same directory or account each get
their own chat, transcript, tool context and wake channel. The chat is available
in the app and `clankie conversations list`. A running service and operator
credential are required; failure to create the chat stops the launch.
`--resume` reopens the last seat for that Claude command and its chat. The
conversation selection is retained on resume, and a different `--conversation` is refused.
Skill selection is reapplied at launch, but resumed history can still contain previously loaded guidance.
`--conversation ID` selects an existing global/workspace service conversation or
Discord text/voice room, resolves its cwd through `/v1/captain/seat-context`, and
opens the selected harness there. That
workspace must exist on the native host. The prompt includes its agent
instructions and the owner's persona/fleet preferences. The MCP bank and channel
share its conversation. Inherited worker capabilities and conversation
selections do not select the seat. Use `--conversation global-default` to select
the shared global chat. Workspace seats do not rename themselves as the global Herdr head.

While its channel is live, the seat receives that conversation's worker reports,
escalations, wakes and watches instead of starting a service model turn. Closing
the seat returns new inputs to the service runner. A turn already accepted by
either destination keeps that destination; uncertain native delivery is never
replayed automatically. Service goals require a Pi-owned conversation. Native
harness MCP seats refuse `create_goal` with `native_goal_unsupported`; owner
activation or resume also refuses while a native head owns the conversation.
Queued or restored service goals pause on finding a native head, so they cannot
start another Pi lead alongside the seat. Internal self-wakes, watch notifications
and worker messages also keep the native receiver while its polling channel is
offline; they do not start a Pi lead. Failed self-wakes remain scheduled and
retry after 5 seconds, doubling to a maximum interval of 5 minutes. Each chat
has its own retry delay, and a replacement wake starts with a fresh delay.
`/autonomy clear` cancels the selected chat's scheduled wake; it does not cancel
an already running turn. Worker reports retain their original delivery IDs and
require explicit read acknowledgment after delivery.
Model calls in Pi create inactive
proposals; `/goal accept` confirms one. `/goal <objective>` creates an active goal
directly. Starting, accepting and resuming a goal, and `/autonomy on`, require the
owner/device credential; the shared captain bearer receives HTTP 403
`goal_owner_required`. The console uses its owner transport, and headless owners
can use `clankie conversations goal ID accept|resume` or
`clankie conversations goal ID set [--tokens N] <objective>`. An omitted action
reads status; `pause|clear` and status use the captain transport. This raises the
activation bar, but a same-UID shell can still read Keychain credentials or the
device signing key; it does not provide OS-level owner isolation (ADR 0130).
Every service goal defaults to a 1,000,000 model-token budget, overridden
with `/goal --tokens <n> <objective>`. Recorded usage survives budget migration
for older goals, and exhausted goals stop before another provider request.
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

`clankie codex` opens the real Codex TUI on its own app-server thread.
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
pushes worker reports, self-wakes, herdr completion watches and room escalations into the
session as `<channel source="clankie" kind="message|wake|watch|escalation"
conversation="…" event_id="…">`; that polling is what binds the seat as his
head, and with no bridge polling the same turns run the pi operator lane. A
`reply` tool answers an escalation by `event_id`; the reply lands in the
escalating conversation as his own message. Claude Code loads the channel
only when `clankie claude` passes its development flag; without it the tools
still work without consuming events, leaving those turns with the service.

Worker `message_clankie` reports project as `kind="message"`, framed as
untrusted agent output, never an owner instruction. Completion harvests remain
`kind="watch"`, and self-wakes remain `kind="wake"`. These tags do not change
the service-owned lead route or delivery receipts. A room-owned worker message
still uses `reply` with its `event_id` for the correlated room reply; the original
actor, route and mouth checks remain in force.

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

<a id="mcp-fleet-fleet-connected-tools"></a>

### `mcp --fleet`: fleet tools and native worker messages

Register `clankie mcp --fleet` in Codex with `env_vars = ["HERDR_PANE_ID",
"HERDR_SOCKET_PATH"]`, or install the `clankie-worker@clankie` Claude plugin.
Preserve generated/symlinked harness configuration: inspect
`doctor.harnessBridges.codex.configSource` and edit its owning source.

Admitted fleet panes receive every connected MCP tool whose account is verified,
except persona-bound Linear worker-publishing tools. Admission uses the pinned
local Herdr socket, a live remote relay stream, or a remote fleet link bearer.
A bearer proves only its fleet, with no verified pane or mailbox authority.
No project grant, native session or workspace proof is needed for these tools.
Projects retain roles, caps, hiring and tracker binding.

The connected-tool service lists `clankie_tools` and `clankie_call`; the shared
worker bridge adds `message_clankie` and, for a proven native sender while peer
messages are on, `list_fleet_seats` and `message_peer`. Search connected tools
with `{query}` for at most 20 names/descriptions,
or `{names}` for up to 10 input schemas, then call with `{name, arguments}`.
`message_clankie` reports to the conversation that hired the worker. A
host-admitted `message_seat` from another conversation adopts that worker, so
future reports and completion watches follow the new lead. The worker does not
choose the destination. Worker reports fall back to `global-default` when that
conversation has been removed; a retained room with revoked grants is refused.
Local and fleet-qualified remote workers follow the same persisted ownership
proof and delivery receipts.
Worker output remains in the owning conversation independently of a worker pane.
`clankie agents reports --conversation ID [--limit N]` (or `worker_reports`)
returns the oldest unread reports with their original delivery IDs and exact text.
Reading does not mark them read. After reviewing every offered report, run
`clankie agents reports ack DELIVERY_ID... --conversation ID` (or
`acknowledge_worker_reports`). Only fully offered IDs can be acknowledged.
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

Use `list_fleet_seats({})` to discover seats in the sender's own fleet, then pass
the returned recipient `seatId` as `seat` to `message_peer({seat, text})`. The
bridge obtains the sender and recipient bindings; workers do not supply them.
Both the Claude worker plugin and `clankie mcp --fleet` use `runSeatChannel` for
this path. The server requires the caller's proven native pane process and matching
session, confines recipients to the same fleet and checks their current binding.
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
unknown, the original is never resent, and fresh messages are allowed. The service
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
updating `mcp_servers.clankie.env.CLANKIE_CATALOG_REVISION` with
`config/value/write`, then calling `config/mcpServer/reload`. The next model step
uses the refreshed connection on the same loaded thread. Do not edit the owner's
config, restart a shared daemon, fork the thread or delete a claim. An embedded
or remote session without that controller needs its owner's exact-session
reconnect after the old runtime unloads.

After refresh, invoke `message_clankie` once to read the original receipt. A
matching positive stored result or terminal `definitive: not_sent` result settles
the retained claim; that invocation still sends no replacement. Invoke again
deliberately to send the later report. A timeout, unauthenticated or mismatched
lookup stays uncertain. See [the worker fleet regression evidence](testing/2026-10-05-worker-fleet-tools/README.md).

### `project create PROJECT --settings FILE.json --revision REVISION`

Requires a service build containing the local project-creation route; a source
landing does not update an installed CLI or the running service. Read
`clankie project list`, then review a proposal file and submit it with the returned
revision. `/project create` uses the same owner-authenticated API. Ordinary
preference answers do not authorize creation.

The file requires `name` and `workspacePath`; `PROJECT` and `REVISION` are explicit
arguments and cannot be supplied or overridden by the file. Optional `roles`,
`workerCap`, `trackerRef`, `trackerSetup` and `fleet` use the existing project policy vocabulary. Role and
project caps may be `null` to inherit; zero stays an explicit zero. Fleet size
and model preferences do not imply numeric caps or new hiring guidance.

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

In an unassigned owner workspace conversation, Clankie receives the onboarding
opportunity and can read the repo, ask about tracking, propose useful roles and
ask about fleet size through the existing dialog questions. Answers are context;
`propose_project_create` puts their complete configuration into the existing
explicit CREATE review. Confirmation consumes that proposal once. Tracker and
project settings are two file writes: a failure after tracker save can leave
only the tracker. An uncertain confirmation stays uncertain and is checked
with the original proposal target, never replayed. See the
[closure evidence](testing/2026-10-05-project-onboarding/README.md) for source
checks and the remaining live acceptance. Project village visuals belong to
VUH-1710.

### `project list`, `project settings` and `project update`

`clankie project list` reads the current project settings and their revision.
`clankie project update PROJECT --changes FILE.json --revision REVISION` submits
reviewed changes for an existing project through the authenticated service API.
The console exposes the same verbs through `/project`.

The changes file may contain `name`, `roles`, `workerCap`, `trackerRef` and `autonomy`.
Omitted fields remain unchanged; `null` removes a worker cap or tracker binding.
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
and their current effective values. Add `--closure lead|owner|inherit` or
`--machine-setup lead|owner|inherit`, `--commit lead|owner|inherit`,
`--push lead|owner|inherit`, `--release lead|owner|time_rule|inherit`
(with `--release-rule TEXT` for `time_rule`),
`--verification review_and_seal|change_run_read|inherit`, or
`--report-style TEXT|inherit` to change only that leaf through the current
revision-bearing owner API. Missing leaves inherit the global setting independently;
`inherit` removes the selected override without changing its sibling. The console
accepts the same syntax as `/project settings PROJECT ...`.

```sh
clankie project settings garden --closure owner
clankie project settings garden --machine-setup lead
clankie project settings garden --closure inherit
clankie project settings clankie --release time_rule --release-rule "Release without asking when the last v* tag is more than one week old and main has user-visible changes worth shipping."
clankie project settings garden --commit owner --push inherit
clankie project settings garden --report-style "Short and plain."
```

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

### `project add NAME --workspace PATH`

The owner can approve one local project workspace with `clankie project add NAME
--workspace /absolute/canonical/path`. This local settings command requires the
canonical broker operator credential and an existing directory with exact canonical
spelling. A new project ID creates a project; an existing ID appends one workspace
while preserving its name, roles, caps, tracker, grants and assignments. Duplicate
or nested-overlapping local workspaces are rejected across all projects, including
the same project. Appended workspace IDs are derived deterministically from the
machine, platform and canonical path. It creates no roles, assignments or tool
grants. Fleet connected-tool access is independent of these project approvals.

### `access` and `mcp --grant FILE`

`clankie access linear [verify]` reads or verifies the connected account.
`access list`, `access issue REQUEST.json --out GRANT.json` and `access revoke ID`
manage individual worker grants. The private file feeds `clankie mcp --grant FILE`,
which serves only granted tools and loads no operator bearer or seat channel.
Tokens expire after at most 15 minutes and require explicit reissue.

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
a fresh outstanding known native tool establishes it. Unknown kinds are refused;
notes and shell arguments are never classified. Omitting `--activity` on the
next stance clears it. The statement expires, belongs to this exact occupying
session, and is absent for idle/offline seats. Unsupported native telemetry
can still carry a live explicit statement; absence means unknown.

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

Read the connected server, Clankie's role, fleet toggle, tracking level and
setup checks. TUI `/discord` uses the same host definition and revision-fenced
writer. The server is chosen by name; channel and Discord-role pickers do not
appear in normal setup. Raw IDs and machine-access grants live under Advanced.

```sh
clankie discord setup choices connect
clankie discord setup invite --role participant
clankie discord setup connect --server Studio --role participant
clankie discord setup connect --server Oathkeeper --role admin
clankie discord setup fleet --enabled on
clankie discord setup fleet --enabled off
clankie discord setup tracking --level project_updates
clankie discord setup tracking --level project_activity
clankie discord setup tracking --level all_issues
clankie discord setup tracking --level off
clankie discord setup check
```

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

The worker plugin uses the matching fleet link when available. Only transport
proof of the current native pane/session can register or drain its next-turn
mailbox; a bearer-only lifecycle report cannot. Without a live channel,
`message_seat` reports `deliveryStage: stored` for an observed receiver and holds
the reply up to 24 hours. The synchronous `UserPromptSubmit` hook writes it as
additional context once and acknowledges its message IDs after stdout succeeds.
That receipt means bridge delivery, not model consumption. A lost handoff remains
`uncertain` and is never automatically replayed. Sessions without an observed
receiver remain unavailable.

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
credential. No host file path is read by the service. The session is pinned to its
conversation; retries and resume retain the same native entry identities. The
next hook retries retained records after a transport failure. The final page carries
`responding` at prompt submission or tool progress and `waiting` at session start/end or stop/failure;
compaction leaves activity unchanged. Empty transcripts still carry lifecycle
activity. These are display signals, not service-run completion or ownership. Reset retires that
conversation's native sessions; launch a new seat afterward so old history cannot
repopulate the cleared conversation. Sync failures never
instruct the harness to continue or block a stop. The current 9,000-entry display tail
is the replay bound. Image files use `clankie file publish` separately.

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

- `/setup` — first-run sign-in and model choice → phone sign-in and `/pair` →
  optional `/connect` → first agent's folder/task and a reviewed request through
  Clankie's normal conversation. An active phone with chat access is required
  to mark pairing complete; a minted QR is only an offer. `/setup rooms` opens
  the other settings checklist. Escape or `/cancel` stops the current step;
  re-entry reads live device/roster state. `doctor --json`'s `captain` field is
  its headless model readiness
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
Without `--conversation ID`, each fresh launch creates a separate workspace
chat; dry-run creates none. `/opencode`
in the console reviews the same plan. Installation, per-launch settings,
removal, native delivery semantics and current verification limits are in the
[OpenCode seat guide](../integrations/opencode-plugin/README.md).

### Grok Build worker and operator seats

`clankie grok --dry-run` or `clankie seat --harness grok --dry-run` reviews the
native launch, profile, selected skills and conversation. Remove `--dry-run`
to open the interactive Grok Build TUI. This adapter requires macOS and verified
Grok Build 1.0.46 on PATH, an existing Grok sign-in, and Clankie's operator
credential. It uses the current `GROK_HOME` (otherwise `~/.grok`); it never
changes accounts or signs in. `/grok` reviews the same plan in the console.

Each fresh launch creates a separate workspace chat. `--conversation ID`
selects an existing conversation; `--resume` retains its exact native session,
profile and chat after a confirmed exit. An uncertain prior exit or delivery
refuses another launch until the original TUI and receipts are inspected.
`--plugin-dir` and numbered account commands are unsupported. Persona and the
memory card come from the selected service conversation; selected skills are
provided as paths to their `SKILL.md` files. Native transcripts and service wakes
follow that conversation through the existing operator API/outbox.

`hire_agent` with `harness: "grok"` creates a visible worker in its own repo tab.
The brief and `message_seat` follow-ups use leader IPC/ACP on that exact TUI
session. Explicit model/effort choices must match the native registry; unavailable
choices refuse. The worker gets the fleet meta tools and `message_clankie`.
Queue consumption is a delivery receipt, not a completed reply. A saved Grok
transcript without its original live controller cannot be resumed as a hire.
Pipeline splitting and control adoption after a service restart are unsupported.

Native permissions remain owner decisions. Grok leader mode ignores CLI
`--allow`/`--deny`; this launcher does not claim they isolate tools. An observed
enabled direct Linear MCP endpoint refuses before the worker brief: disable it
in that Grok profile and start a fresh seat. A missing native catalog, changed
session or process, unavailable sign-in, or uncertain acknowledgment retains
the original evidence and names the refusal; no headless or terminal-input
fallback runs. See [ADR 0224](adr/0224-grok-build-shares-the-visible-native-session.md).

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

Discord room inspection, private next-turn guidance, delivery health and exact-stay voice controls are documented in [Discord rooms](discord-rooms.md). Use `clankie discord rooms`, `clankie discord guide CONVERSATION_ID TEXT`, and `clankie discord call`.

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
clankie herdr prepare pc --codex-source-setup 'C:\Users\volpe\dotfiles\scripts\codex-worker-setup.py'
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
includes background Discord captain turns. `activeSeats` counts all live
registered fleet seats, including those waiting between turns. Optional
`nativeSubagents` counts only running native children of the live local Clankie
captain session, never workers or their children. It is absent when the parent
or transcript is unavailable, and zero when a readable parent has no running
children. Child and parent-session changes wake the presence poll independently
of fleet-seat changes. The oldest
unanswered owner preference appears as `pendingOwnerItem`, with the conversation
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
`new_message` for ten seconds; a failed owner turn shows `error` for thirty
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
even during an input batch; its next input refuses. Recovery still needs host stop
proof.

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
Any native error retires the host. Release remains gated on James's W8 live
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
`artifact:CONVERSATION_UUID:ARTIFACT_ID`. GIF is an animation; MP4 is a finite demo.
PNG is also accepted through this source form. Files are checked against the
stored digest; animations/demos are bounded to 32 MiB and 120 seconds.

```bash
clankie share request '{"action":"start","sourceId":"artifact:CONVERSATION_UUID:ARTIFACT_ID","guildId":"GUILD_ID","channelId":"CHANNEL_ID"}'
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
