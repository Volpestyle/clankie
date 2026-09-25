# CLI

The `clankie <noun> <verb>` command layer is the canonical local control
product. Its noun modules return JSON-shaped results. The argv face prints
those results; the fullscreen TUI is chrome over the same functions, with
modals that collect flags, render the result, and navigate. Neither face shells
out to the other or owns a second config writer
([ADR 0012](adr/0012-provider-auth-model-registry.md)).

Live operator work stays on the service HTTP catalog already shared by the TUI,
phone, relay, and menu bar: chat, play, memory, pairing, and conversations are
not launcher configuration commands. This page is the contract for agents,
scripts, and anyone driving Clankie without a TTY.

`clankie help` prints the same command index. On every install the file lives
at `{repoRoot}/docs/cli.md` — `clankie doctor` names `repoRoot`.

## Invocation

```bash
clankie                         # start the core service and open the console (TTY)
clankie --version               # also -V
clankie --chat <conversationId> # resume a server-owned operator conversation
clankie <command>               # headless; no TTY
clankie help                    # also --help, -h
```

`--chat` is stripped before headless routing. With no command, the launcher
starts the clankie service if needed and opens the existing main **Clankie**
conversation, regardless of the launch directory. It does not create a chat.
Use `--chat ID` for another retained conversation, `/new` for a fresh chat,
or `/cd PATH` to select a project conversation.

## Conventions

| Rule                            | What it means                                                                                                                          |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| One JSON document on stdout     | Agents parse stdout. Progress and human narration go to stderr.                                                                        |
| Exit 0 or 1                     | 0 is success. 1 is failure. `doctor` always exits 0 — `ok` means the card was produced.                                                |
| Secrets never as flags          | No API keys, Discord tokens, or operator bearers on the command line. `/auth` and `/discord` in the console, or the credential broker. |
| Fail closed, secret-free errors | Failure messages never echo tokens, pairing codes, or response bodies.                                                                 |
| Host                            | `CLANKIE_CONTROL_PLANE_URL` (default `http://127.0.0.1:4310`). `CLANKIE_CAPTAIN_URL` is a compatibility alias.                         |

`--json` is required only where the default is human-readable (pairing QR,
device table, credential-rotate sentence). Everything else is already JSON.
`rivals connect --token-stdin` reads its bridge token from a pipe into the broker;
the token is never an argument, settings value, or printed result.

| Command                                                                                                      | stdout                                                                                       |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `health`, `status`, `doctor`, `restart`, `down`, `autostart …`                                               | JSON                                                                                         |
| `model …`, `effort …`, `image-model …`, `video-model …`                                                      | JSON                                                                                         |
| `linear …`, `persona …`, `games …`, `browser …`, `fleet …`, `herdr …`, `workdir …`, `discord …`, `gateway …` | JSON (`herdr open` opens the terminal viewer)                                                |
| `play status`                                                                                                | JSON                                                                                         |
| `send --conversation ID …`                                                                                   | JSON accepted-run receipt or refusal                                                         |
| `file publish --conversation ID PATH …`                                                                      | JSON delivered-file metadata                                                                 |
| `memory …`, `metrics …`                                                                                      | JSON                                                                                         |
| `play stop`                                                                                                  | JSON when a session is stopping; the sentence `Nothing is playing.` when idle (still exit 0) |
| `prompt …`, `memory-card …`                                                                                  | Plain text: the prompt or card itself, verbatim                                              |
| `seat`                                                                                                       | Interactive (TTY); `seat --dry-run` is JSON                                                  |
| `mcp`                                                                                                        | JSON-RPC for a harness, never for people                                                     |
| `pair`, `devices`, `operator-credential rotate`                                                              | Human text; pass `--json`                                                                    |
| `help`                                                                                                       | This index (plain text)                                                                      |
| `--version`                                                                                                  | `clankie <version>`                                                                          |

Do not edit `~/.config/clankie/clankie.json`,
`~/.config/clankie/settings.json`, or Keychain entries by hand.

## Commands

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
`discord-user-session`, `activity`, `tunnel`.

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

When Clankie runs this from his own operator-turn bash, the launcher waits
for that turn to settle. Stdout then reports `"status": "scheduled"` with
`afterRun`, and stderr says the restart is deferred. That is success (exit 0),
not a no-op.

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

### `pair [--json] [--timeout SEC] [--review --days N [--count N]]`

Mint a one-time pairing offer (QR + code + deep link) for the phone/desktop
app. Pairing reuses a healthy app relay or starts a stopped one before minting
an offer. If the relay cannot start, no offer is minted. A configured public
doorway carries the offer, so when this Mac has no live connection to it —
`doorway.state` anything but `connected` — pairing fails `unavailable` rather
than handing out a code the phone can only report as unrecognized. `--timeout` covers
startup and minting together and defaults to 30 seconds; an ordinary offer
lives five minutes. A remote `CLANKIE_CONTROL_PLANE_URL` fails with
`unavailable`: run pairing on that host so its launcher can verify the relay.
The console's `/pair` runs this same command and accepts the same flags.

Public-gateway pairing uses a secure QR or full pasted link; the encryption
credential is in its fragment. Short codes are for direct private connections.
Human mode writes the QR and code/link to stdout. Those values are secret-bearing
display data — never log or persist them. `--json` is the agent form:

```json
{
  "ok": true,
  "code": "ABCD-EFGH",
  "deepLink": "clankie://pair/…",
  "expiresAt": "2026-08-30T12:00:00.000Z"
}
```

`--review --days N` mints a review offer for App Review or a TestFlight tester
who will pair hours or days later: `--count` (default 3, max 10) independent
single-use codes that each live `N` days (max 31, the public gateway's route
window) and survive a Clankie restart. Human output is headed `REVIEW OFFER`
and lists `Code 1…N`; `--json` is
`{ "ok": true, "review": true, "expiresAt": "…", "offers": [ { "code", "deepLink", "expiresAt" } ] }`.
Mint review offers only after the public gateway release that accepts them;
an older gateway drops the Mac connection on the first review route.

Failure with `--json`: `{ "ok": false, "status": "unavailable"|"unauthorized"|"expired"|"malformed"|"interrupted", "error": "…" }`.
Without `--json`, the same message goes to stderr and stdout stays empty when
no offers were minted. If a review batch fails after minting some offers, the
command still exits 1 and displays those live codes: JSON adds `partial: true`,
`review: true`, and `offers`; terminal output starts with `PARTIAL`. Each code
remains usable until consumed or expired.

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

`set --url URL --host-id ID` remains only for legacy static-bearer migration and
local verification. It never accepts a secret as a flag.

### `linear status` / `linear follow on|off`

With the webhook configured, accepted events appear in the **Linear inbox**
conversation (`linear-inbox`) as **External activity** messages, including swarm
posts delivered by the webhook. Following controls whether those messages wake
Clankie:

| Following     | Inbox delivery                          | Automatic model turns                |
| ------------- | --------------------------------------- | ------------------------------------ |
| Off (default) | Events stay visible in the conversation | None from incoming events            |
| On            | Events stay visible in the conversation | New events wake their selected owner |

Activity authored by Clankie's own verified Linear account, his or a
worker's, is collected but never wakes him ([ADR 0189](adr/0189-his-own-linear-activity-does-not-wake-him.md)).
Before a wake, a Linear inbox context above 30k tokens is compacted.

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
`clankie linear status` reads the switch. All three return JSON with `ok`,
`following`, `conversationId` (`linear-inbox`), and `settingsFile`.

Unbound work wakes the inbox's model context. Explicit issue bindings route new
activity to the selected Clankie conversation or native seat. Events remain in
one canonical inbox. Removing the webhook stops delivery; following off keeps
delivery enabled.

Configure the webhook from `/connect linear` → **Follow Linear** → **Configure
webhook**. The flow prints the public URL and stores the signing secret in the
credential broker (`linear-webhook`). In Linear's webhook settings, select **all
available activity events**, including issues, comments, projects, and updates.
An existing Comments-only webhook also needs its event selection expanded there.
Setup does not enable following; **Start following** / **Stop following** is a
separate choice under **Follow Linear**.

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
"conversationId": "linear-inbox" }`. The signed public ingress remains
`POST /v1/hooks/linear`. Changing the local follow switch does not change which
events Linear sends; the owner configures that subscription in Linear.

#### Issue ownership

Use provider UUIDs, not issue labels or email addresses. Bind only work the
operator authorizes Clankie to lead:

```bash
clankie linear work list
clankie linear work bind ORG_UUID ISSUE_UUID CONVERSATION_ID
clankie linear work bind ORG_UUID ISSUE_UUID NEW_CONVERSATION --from CURRENT_CONVERSATION
clankie linear work unbind ORG_UUID ISSUE_UUID CURRENT_CONVERSATION
clankie linear inbox read --conversation CONVERSATION_ID
clankie linear inbox ack CURSOR --conversation CONVERSATION_ID
```

The same commands are available through `/linear` in the TUI. Bindings require
an existing Clankie global/workspace conversation and prevent its automatic
pruning or removal until unbound. The expected owner protects a rebind from
concurrent changes. New Issue and Comment deliveries use that owner; an already
admitted event keeps its original destination across retries and rebinding.
Unbound activity uses `linear-inbox`. No binding grants provider access or turns
webhook text into operator instructions. The lead checks current Swarm ownership
before assigning work or replying.

`GET /v1/linear/work` returns `{ owners: [...] }`. Operator-authenticated `PUT`
accepts `{ organizationId, issueId, conversationId, expectedConversationId? }`;
`DELETE` accepts the current organization, issue and conversation. Conflicts or
unavailable owners return 409. Inbox GET accepts `conversationId`; acknowledgment
POST accepts the same optional field alongside `ackCursor`. Omission reads the
whole inbox. Never acknowledge a cursor under a different conversation.

Signed-event identities commit with the inbox record, surviving restart and
history trimming for the provider retry window. Pending followed wakes resume
on startup when following is enabled; passive backlog stays passive. A recovered
lead reconciles existing work before repeating external side effects. Current
storage and recovery limits live in [ADR 0168](adr/0168-linear-awareness-is-opt-in.md).

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

### `model [status]`

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
An `openai` selection uses the subscription when available; disable the
`openai-codex` provider to select the metered API transport explicitly.
In a checkout, `pnpm --filter @clankie/clankie verify-model provider/model@effort`
checks a captain tool-and-image turn, a gameplay action, and commentary using
isolated settings. It makes live provider requests. Add `--metered` for the API
transport or `--json` for a machine-readable receipt. `--config-home PATH`
checks the selection previously written by the CLI under that configuration
home. The owner's live selection remains unchanged.

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

### `browser [status]` / `browser record on|off`

Read or set `browser.recordSessions`. When on, each burst of Clankie's browsing
is saved as a WebM under `~/.clankie/runner/browser/recordings/`: recording
starts before the burst's first browser call and stops after 60 seconds without
one; the newest 50 are kept. Off by default, because videos capture every page
he opens, signed-in ones included. JSON contains `browser.recordSessions`,
`settingsFile`, and `"appliesTo": "next_browsing_burst"` — no restart is needed.
The TUI `/browser` command calls this same writer.

### `fleet [status]` / `fleet set --notes TEXT` / `fleet clear`

Read, set, or clear how the owner wants work routed across the agents Clankie
leads — which harness is the workhorse, which one reviews, what never goes to
which. Up to 4,000 characters of free text.

**The default is empty**, and empty means he picks a harness per job on his own.
Nothing here ships with an opinion; this is where you add one.

It is free text rather than a table of roles because an enum of
`reviewer`/`implementer` only covers the situations someone enumerated, and the
useful ones are conditional ("never codex on Swift", "grok for a hostile read on
work that already passed review"). The thing reading it is a model.

The notes reach him as the `fleet` prompt section, and only on lanes that hold a
shell — a room that cannot dispatch would carry the section for nothing. They are
preference, not authority: the section says plainly that he still reads the work
and decides, and a note here can no more widen his reach than a warmer persona
can. Unset renders no section at all.

JSON contains `{ "ok": true, "fleet": { "notes": "…" }, "settingsFile": "…", "restart": "clankie restart captain" }`.
The TUI `/fleet` command opens the same editor and `/fleet status` prints the
same values.

```bash
clankie fleet set --notes "codex is the workhorse. claude when it needs skills or long context. grok for a hostile read on work that already passed review. never codex on Swift."
```

### `connections` and `runtime`

`clankie connections` (`/connections` in the TUI) combines execution runtime health,
Swarm connections/diagnostics and the recorded Linear account identity. Its
operator API is `GET /v1/connections`; the companion app does not display this
inventory yet.

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
share the service's filesystem and executable paths. For workers on another
machine, connect their Swarm coordinator using the external-connection contract.

For custom capacity/capabilities, `runtime connect CONNECTION.json` accepts
`{ "id": "build", "session": "workers", "capacity": 2, "capabilities": ["code"] }`.
A socket can replace `session`. `default` is reserved for the existing fleet;
`runtime:` capability names are reserved for explicit routing. Up to 15 named
connections are stored under `execution.connections`.
The operator API is GET/POST `/v1/runtime-connections` and DELETE
`/v1/runtime-connections/ID`; GET `/v1/herdr?connection=ID` resolves a live binding.

For new routed work, `swarm_assign` accepts `runtime: "build"` beside its `routing`
object. This is independent of the coordinator's `connection` field; runtime
selection applies only to the embedded coordinator. Retries keep their original
runtime, intent and payload. The coordinator reloads route configuration before
dispatch, and connect/disconnect synchronizes existing owned coordinators. Older
coordinator processes report `restart-required` and refuse managed route changes
until deliberately upgraded/restarted; replacing a package does not upgrade a
running owner. Configuration failures return an error: inspect inventory before
retrying rather than assuming a disconnect completed.

### `agents [list]` / `agents read` / `agents hosts`

Clankie reads any Claude Code or Codex session from the agent's own transcript,
on this machine or an owner-configured SSH host. No terminal host is involved: a
session in Herdr, tmux, or a bare PowerShell tab reads the same way
([ADR 0189](adr/0189-agent-sessions-read-from-their-transcripts.md)).

```sh
clankie agents hosts add pc --ssh volpe@supedupsilly --shell powershell
clankie agents                          # every host, newest first
clankie agents list --host pc --limit 5
clankie agents read pc:01a0da31 --tail 20
clankie agents read pc:01a0da31 --after CURSOR
clankie agents hosts remove pc
```

A remote host needs only sshd and its default shell; nothing is installed there.
Authentication is the owner's SSH configuration (keys, `~/.ssh/config` aliases).
Reads are confined to `~/.claude/projects` and `~/.codex/sessions` on that host
and capped at 4 MiB per call. `local` is always present. Hosts are stored under
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

`/agents` in the TUI takes the same arguments. The operator API is
GET `/v1/agent-sessions?host=&limit=`, GET `/v1/agent-sessions/read?ref=&tail=|after=`,
GET/POST `/v1/agent-hosts` and DELETE `/v1/agent-hosts/ID`. Clankie's own tools are
`agent_sessions` and `agent_session_read`, available where he has machine access.
Reading is not messaging: send to an agent through Swarm.

### `herdr [status|open|create]` / `herdr use NAME`

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
connected services and Swarm peer communication remain available. Terminal actions
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

`clankie herdr status` reports configured `herdr`, `settingsFile`, `restart`,
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

### `conversations list | show ID | tail ID`

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

### `send --conversation ID [--delivery steer|queue] (MESSAGE | --stdin)`

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

| Section    | What it is                                                              |
| ---------- | ----------------------------------------------------------------------- |
| `identity` | `instructions.md` — who he is and how he works                          |
| `persona`  | The owner-authored character configuration                              |
| `reach`    | The machine-access or this-room paragraph for that lane                 |
| `fleet`    | Owner-authored routing preference; shell-holding lanes only, when set   |
| `address`  | His own mailbox, when one is connected                                  |
| `model`    | The card naming the model the service lanes run on (ask for it by name) |

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

### `memory-card [--lane LANE]`

The memory card that lane's next run injects, printed verbatim as plain text.
The intended consumer is a per-turn hook, so a seat in another harness carries
the same recent past his own sessions do.

Filtered by lane exactly as the session's own injection is: operator-private
episodes reach only the operator lane. Empty output means the lane has recalled
nothing yet, which is not an error.

### `seat [--resume] [--conversation ID] [--plugin-dir PATH] [--dry-run]`

Sit in Claude Code as Clankie ([ADR 0152](adr/0152-a-harness-takes-the-operator-seat.md)).
Needs a TTY and `claude` on `PATH`. The launcher does the things the plugin
cannot: it passes `--settings` with the permission allowlist for `clankie`
commands and, when the plugin is installed from the repo's marketplace
(`clankie@clankie`), `enabledPlugins` for this session only plus the channel
development flag so wakes and escalations reach the session. The plugin stays
disabled at user scope, because its forced output style would otherwise make
every Claude Code session answer as him. When the plugin is not installed it
loads the bundled `integrations/claude-plugin` with `--plugin-dir` (tools and
skills, no channel). Inside a herdr pane it names that pane `clankie` once Claude Code
is detected there, which binds the pane to his own persona rather than a fleet
contact; a second pane claiming the name stays an ordinary fleet agent and is
told so on stderr. The pane is un-named again when the session ends.

Every seat starts a new Claude Code session under a recorded id;
`--resume` reopens the last one from the directory it was opened in. The
selection is retained on resume, and a different `--conversation` is refused.
`--conversation ID` selects an existing global/workspace service conversation,
resolves its cwd through `/v1/captain/seat-context`, and opens Claude there. That
workspace must exist on the native host. The prompt includes its agent
instructions and the owner's persona/fleet preferences. The MCP bank and channel
share its conversation/Swarm actor. Inherited worker capabilities and conversation
selections do not select the seat. The default remains the global conversation.
Selected project seats do not rename themselves as the global Herdr head.

`--dry-run` prints the launch plan instead of launching:

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
    "…/integrations/claude-plugin",
    "--session-id",
    "…"
  ],
  "plugin": { "source": "plugin-dir", "path": "…/integrations/claude-plugin" },
  "channel": false,
  "sessionId": "…",
  "resumed": false,
  "cwd": "/Users/me/dev/project",
  "herdrPaneId": "w1:p2"
}
```

`plugin.source` is `installed` with `channel: true` after
`claude plugin marketplace add <repoRoot>/integrations/claude-plugin`,
`claude plugin install clankie@clankie`, and `claude plugin disable
clankie@clankie`. The plugin README documents the install and what the plugin
carries.

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

### `access`, `mcp --swarm`, `mcp --grant FILE` and `mcp --swarm-grant ID`

`clankie access linear [verify]` shows or verifies the connected Linear API-key or OAuth
account. `access list`, `access issue REQUEST.json --out GRANT.json`, and
`access revoke ID` manage worker grants. `/access` in the TUI exposes status,
verification and revocation. Issue from the terminal. For enrolled workers,
the built-in Herdr route supplies `clankie mcp --swarm` automatically. External
workers can configure it with `SWARM_SCOPE`, `SWARM_SESSION_CAPABILITY` and the
selected `CLANKIE_CONTROL_PLANE_URL`. It starts with no tools; explicit grants
appear through MCP tool-list notifications. Each request checks the actor's
current account and assignment authority. No operator credentials are loaded.
`access issue REQUEST.json --deliver swarm` prints a non-secret grant ID and
bridge command, with no grant-file handoff. `mcp --swarm-grant ID` retrieves only
that worker's existing grant using `SWARM_SESSION_CAPABILITY`; it uses no operator
credential. Select a remote service with `CLANKIE_CONTROL_PLANE_URL` (HTTPS).

`clankie mcp --grant FILE` serves that worker's granted connected tools. It is
mutually exclusive with `--swarm`, `--swarm-grant`, `--seat` and `--lane`, and loads no operator bearer or
channel. Tokens last at most 15 minutes. Swarm-bound grants with `renewable: true`
renew automatically while the same assignment remains authorized; others need
explicit reissue. Verified Linear API keys and MCP OAuth connections support delegation.
See [worker access](worker-access.md) for request fields, delivery and restrictions.

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

## External native agent chats

Herdr discovery provides agent identity, routing and status. It does not import
external conversations or create chat threads. Opening a persona chat and using
the existing `replay`/`tail` operations reads the harness session on demand,
including messages, tools, typing state and contained images. Native cursors are
opaque; clients follow the returned recovery cursor after a session or history
change. The host persists the source locator, not a second native transcript.
Explicit app sends and Swarm exchanges remain durable host communications.
Clankie can inspect panes and arm completion watches independently of chat views.
See [the native chat decision](adr/0188-native-agent-chats-read-their-own-history.md).

## Independent evaluator

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

The evaluator defaults off and captures only Clankie’s Pi turns and native
head-seat replies while enabled. Other Herdr agents do not trigger assessments.
Enabling creates its own pane and starts a harness;
new work uses fresh agent context. Captures coalesce for a quiet minute, with
fifteen-minute checkpoints for continuing activity. Only a schema-valid report
from a settled agent completes an assessment. Restart resumes inspection of the
existing assignment; uncertain failures require explicit retry. The service
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

## Native seat transcript sync

`clankie seat-sync` consumes Claude hook JSON on stdin. The `clankie seat` launcher
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
instruct Claude to continue or block a stop. The current 9,000-entry display tail
is the replay bound. Image files use `clankie file publish` separately.

## Swarm coordination

`clankie swarm status` (or `/swarm status` in the TUI) reads the authenticated
`GET /v1/swarm` diagnostic view: configured connections, active conversation actors
and coordinator state. `swarm connections` is the same inventory.
`clankie swarm contacts` lists discovered Swarm personas, including saved offline
contacts. `clankie swarm message PERSONA TEXT` opens its DM and submits one message;
`clankie swarm thread PERSONA` reads a bounded history page. The same commands work
under `/swarm` in the TUI. Select the exact persona ID from the catalog. Replaced
sessions have new contacts; old threads do not redirect. An accepted local turn
is queued, not proof of peer processing; the thread records delivery failures.
See [Swarm contact identity](adr/0182-swarm-peers-are-messageable-personas.md).

Each operator conversation has an isolated inbox. The service delivers messages
through its existing turn queue; processing requires explicit acknowledgment.
`clankie seat --conversation ID` uses the selected service conversation actor
through the Clankie MCP server; omission selects the global head. Its launch
directory does not select another Swarm scope.
With the plugin channel enabled, queued envelopes reach the native seat through
that channel; processing still requires `swarm_inbox` acknowledgment. A plugin-dir
seat has tools but no channel wakes. See the [seat plugin](../integrations/claude-plugin/README.md)
for context, resume and native-workspace requirements.

Use `swarm-lead` for the default leadership workflow, `lead` for shared judgment,
and `swarm-mcp` for peer participation. `herdr-lead` is the explicit fallback.
Through `clankie mcp`, Pi or the Claude seat, `swarm_assign` accepts optional
`skills: ["installed-name"]`. Selected skills and supporting files travel with the
assignment's pinned project context. The existing conversation composer catalog
supplies names. See [skill selection and limits](../packages/swarm/README.md#working-preferences-and-portable-skills-slices-36).

`clankie swarm connect PRIVATE.json` (also `/swarm connect PRIVATE.json`) imports
an externally enrolled Clankie session into an existing operator conversation.
The regular file must be private (0600) and at most 16 KiB. Its exact shape is:

```json
{
  "id": "project-team",
  "conversationId": "global-default",
  "endpoint": "/private/path/coordinator.sock",
  "capability": "<dedicated Clankie session capability from the trusted launcher>"
}
```

Use a session enrolled for Clankie, distinct from worker sessions. The service
verifies its actor/scope and stores only a broker reference in settings. This
connects to the refactored coordinator protocol, not the legacy database API.
An SSH Unix-socket forward can provide the local endpoint for a remote owner;
Clankie does not start, modify or stop that external owner. Provisioning uses
that coordinator's configured routes. A configured connection belongs to one
conversation; that conversation can address several independent coordinators.
Import starts inbox listening immediately, including before its next model turn.

Pass `connection: "project-team"` on any `swarm_*` call. Omit it (or use
`"embedded"`) for the built-in coordinator. Keep the same connection when
replying, acknowledging, reading evidence or retrying an intent. Incoming wake
context names the connection. Instruction snapshots come from the selected
Clankie conversation and stay pinned to that coordinator's work. Reusing a
connection ID for another actor, scope, endpoint or conversation is refused.

`clankie swarm disconnect project-team` disables access, closes its sessions and
removes the brokered capability. External workers and work records stay with
their owner. Import a valid capability for the same retained identity to reconnect;
use a new ID for a different identity. A disconnected or unreachable connection
never falls back to another coordinator. Endpoint/tunnel lifecycle remains the
operator's selected runtime's responsibility; connection loss does not enroll
another session or replay uncertain assignments.

For grants on external work, add `swarm.connectionId` to the issuance request.
Enrolled workers use `CLANKIE_SWARM_CONNECTION=project-team` with
`clankie mcp --swarm`, alongside their own `SWARM_SCOPE` and
`SWARM_SESSION_CAPABILITY`. Their Clankie service URL must be reachable privately
(for example over SSH); the public app gateway does not expose worker MCP routes.
Enrollment still grants no provider tools. [Grant contract](worker-access.md).

See [Swarm architecture](adr/0180-swarm-is-the-coordination-layer.md).
