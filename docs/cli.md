# CLI

The `clankie` launcher is both the fullscreen operator console and the
headless control surface. This page is the contract for agents, scripts, and
anyone driving Clankie without a TTY.

Slash commands in the console (`/auth`, `/provider`, `/model`, `/discord`,
`/connect`, `/persona`, `/voice`) write the same stores. The TUI remains the
human wizard; the CLI is the agent-ergonomic surface
([ADR 0012](adr/0012-provider-auth-model-registry.md)).

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
starts the clankie service if needed and attaches the fullscreen face.

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

| Command                                         | stdout                                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `health`, `status`, `doctor`, `restart`, `down` | JSON                                                                                         |
| `model …`                                       | JSON                                                                                         |
| `play status`                                   | JSON                                                                                         |
| `play stop`                                     | JSON when a session is stopping; the sentence `Nothing is playing.` when idle (still exit 0) |
| `pair`, `devices`, `operator-credential rotate` | Human text; pass `--json`                                                                    |
| `help`                                          | This index (plain text)                                                                      |
| `--version`                                     | `clankie <version>`                                                                          |

Do not edit `~/.config/clankie/clankie.json` or Keychain entries by hand.

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
  "remediations": ["Pick a captain model with `clankie model set provider/model` or `/model`."]
}
```

`kind` is `checkout` or `release`. Credential entries are ids and types, never
secrets. `commands` currently probes `herdr`, `ffmpeg`, `yt-dlp` (version
strings) and `herdr-lead` (PATH only — never execute `herdr-lead --version`).

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

When Clankie runs this from his own operator-turn bash, the launcher waits
for that turn to settle. Stdout then reports `"status": "scheduled"` with
`afterRun`, and stderr says the restart is deferred. That is success (exit 0),
not a no-op.

### `down [service]`

Stop in reverse dependency order. Default `all`. Same stdout shape as restart,
with `"status": "stopped"` on success.

### `pair [--json] [--timeout SEC]`

Mint a one-time pairing offer (QR + code + deep link) for the phone/desktop
app. Default timeout is 10 seconds.

Human mode writes the QR and code to stdout. Those values are secret-bearing
display data — never log or persist them. `--json` is the agent form:

```json
{
  "ok": true,
  "code": "ABCD-EFGH",
  "deepLink": "clankie://pair/…",
  "expiresAt": "2026-08-30T12:00:00.000Z"
}
```

Failure with `--json`: `{ "ok": false, "status": "unavailable"|"unauthorized"|"expired"|"malformed"|"interrupted", "error": "…" }`.
Without `--json`, the same message goes to stderr and stdout stays empty.

### `devices [--json]`

List paired devices. Human mode is a table; `--json` is `{ "ok": true, "devices": [ … ] }`.
Empty human output is `No paired devices.`

### `devices revoke <id> [--json]`

Revoke one device. Human: `Revoked <id> (<name>).` JSON: `{ "ok": true, "device": { … } }`.

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

### `model [status]`

Captain model and every config-declared provider. JSON:

```json
{
  "ok": true,
  "model": "ds4/deepseek-v4-flash",
  "providers": {
    "ds4": { "baseURL": "http://127.0.0.1:8000/v1", "models": ["deepseek-v4-flash"] }
  },
  "restart": "clankie restart captain"
}
```

`ok` is false and exit 1 when `clankie.json` has load issues (`issues` is then
present). `model` is `null` when none is selected. The running service does not
pick up a write until `clankie restart captain`.

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

`clankie model help` prints only the model usage, not the global index.

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
| `CLANKIE_LAUNCHER_PATH`     | Path used to spawn a deferred self-restart.                                                                               |
| `XDG_CONFIG_HOME`           | Config root. Model/provider config is `$XDG_CONFIG_HOME/clankie/clankie.json` (default `~/.config/clankie/clankie.json`). |
| `XDG_STATE_HOME`            | Process records and logs (`$XDG_STATE_HOME/clankie/`).                                                                    |

## Not on this CLI

These stay console slash commands (or the credential broker):

- `/auth` — provider keys and OAuth
- `/discord` — Discord body, tokens, machine grants
- `/connect` — Linear and email
- `/persona` — who he is
- `/voice` — realtime/TTS provider
- `/image-model`, `/video-model` — generation models
- `/effort` — reasoning effort

There is no `clankie start`, `clankie up`, or `clankie auth`. Local model
servers are not supervised.

## Related

- [Operator console](../apps/tui/README.md) — TUI, workspaces, slash commands
- [Distribution](distribution.md) — install layout and `clankie doctor` on a release
- [Credentials](credentials.md) — bot vs user vs internal tokens
- [Architecture canonical homes](architecture.md#canonical-homes)
