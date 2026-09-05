---
name: this-machine
description: >-
  Use when operating or configuring Clankie through the launcher CLI, inspecting this
  installation, diagnosing missing Discord, voice, models, credentials, or optional
  integrations, or checking whether it is a source checkout or installed release.
---

# This machine

You are a running Clankie, not a git checkout. Run `clankie doctor` and believe
that JSON. Do not invent `~/dev/clankie`, do not `pnpm` against a guessed tree,
and do not treat the conversation workspace as your body.

Doctor reports the service root as `repoRoot`. Read files there when you need
your own README or plugin path. `README.md` in the current workspace is whoever
you are helping.

## Three cards

| Question                          | Card             |
| --------------------------------- | ---------------- |
| How is this install put together? | `clankie doctor` |
| Are my processes up?              | `clankie status` |
| What am I doing right now?        | `get_self_state` |

After-the-fact trails (what you said, receipts, play journals) live under the
user's Clankie homes — load `trace-clankie`. Those paths exist on every install.

## Launcher control

This skill is the installed agent companion to the canonical launcher command
layer. Do not write Keychain entries, `~/.config/clankie/clankie.json`, or
`~/.config/clankie/settings.json` yourself. The full flag/JSON/exit-code
contract is `{repoRoot}/docs/cli.md` (every install) and `clankie help` (same
index). Configure through the headless CLI:

| Job                                   | Command                                                                                                           |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| This install                          | `clankie doctor` (JSON; exit 0; `ok` means the card was produced)                                                 |
| Are processes up                      | `clankie status` (JSON; `clankie health` is an alias)                                                             |
| Captain + local providers             | `clankie model status`                                                                                            |
| Add a local OpenAI-compatible runtime | `clankie model add-local --id ds4 --base-url http://127.0.0.1:8000 --set`                                         |
| Switch captain                        | `clankie model set provider/model`                                                                                |
| Captain effort                        | `clankie effort status`, `clankie effort set high`, `clankie effort clear`                                        |
| Image / video models                  | `clankie image-model set provider/model`, `clankie video-model set provider/model`                                |
| Persona                               | `clankie persona status`, `clankie persona set --display-name Clankie …`                                          |
| Gameplay availability                 | `clankie games status`, `clankie games set on`, `clankie games set off`                                           |
| Non-secret Discord setup              | `clankie discord status`, `clankie discord set --active-body bot …`                                               |
| Worker runtime / external session     | `clankie herdr status`, `clankie herdr set --runtime auto\|bundled\|external`, `clankie herdr set --session NAME` |
| His working directory                 | `clankie workdir status`, `clankie workdir set PATH`, `clankie workdir clear`                                     |
| Say what you are doing (for agents)   | `clankie stance working --note "…"` (`thinking`, `stuck`, `hauling`, `resting`)                                   |
| Public doorway                        | `clankie gateway status`, `clankie gateway set --url URL --host-id ID`                                            |
| Pick up model/provider config         | `clankie restart captain`                                                                                         |
| Pair a device / list / revoke         | `clankie pair --json`, `clankie devices --json`, `clankie devices revoke <id> --json`                             |
| Rotate operator credential            | `clankie operator-credential rotate --json`                                                                       |
| Restart / stop a service              | `clankie restart [service]`, `clankie down [service]`                                                             |
| Play session                          | `clankie play status` / `clankie play stop`                                                                       |

`clankie devices --json` includes each device's optional `push` reference and
`enabled` state. It is registration state, not an APNs delivery receipt. Push
permission and registration belong to the phone; operator signing/storage setup
is in `apps/gateway/README.md`. Tokens and delivery keys never go to the host.

`clankie memory status` reports episodes and retention usage. Use `memory search
<terms...>`, `memory retain|release|forget <episodeId>`, or `memory correct
<episodeId> --summary "…"` to curate them through the operator API. Retained
notes survive the recent ring; a full retained store refuses another retain
until a note is released or forgotten. `/memory` is the console browser.
`clankie pair` and `/pair` start or reuse the local relay before minting a code;
run pairing on the host that owns the relay.

JSON is on stdout; progress is on stderr. `pair`, `devices`, and
`operator-credential rotate` default to human text — pass `--json`.

If a newly released model is missing, run `clankie model refresh`, select it
with `clankie model set provider/model`, then restart the captain. Astra accepts
`low`, `medium`, `high`, `xhigh`, and `max`; unsupported efforts fail when a turn
executes. Voice and image/video models have independent selectors.
`play stop` prints `Nothing is playing.` (not JSON) when idle. A bare
`--base-url` origin is rewritten to `/v1`. `--set` selects the first listed
model. If the probe fails, pass `--models id,id`. Local LLM servers (ds4,
Ollama, LM Studio) are not launcher-owned; start them yourself. `stance` moves
your own figure in the commons and takes no seat argument — it resolves
`HERDR_PANE_ID` against the live census, so it can only move the figure you are
sitting in. `--for` defaults to 15 minutes, caps at an hour, and then lapses
back to observed behavior. `{"outcome":"unseated"}` means this pane holds no
fleet seat — normal in a plain shell, not an error.

The person at the console can still use slash commands (`/auth`, `/provider`,
`/model`, `/effort`, `/image-model`, `/video-model`, `/games`, `/discord`,
`/connect`, `/persona`, `/voice`). Their modals are chrome over the commands
above for non-secret configuration. Secrets still go through `/auth`, the
existing wizards, or the credential broker — never flags.

`credential_unavailable` or `not_configured` means nobody connected it yet. Say
that, and point at `clankie model`, `/connect`, or `/auth`, rather than implying
you refused.

Launcher conflicts for Clankie, relay and activity use their configured listen
ports. Linux needs `lsof` for that inspection; without it, a matching process
on another port may still block a start or restart. Never kill a scratch
instance merely because its command resembles the live service.

## Authority

The operator console always has a shell. Discord gets machine tools only for
a system-actor grant; everyone else stays social. Setup wizards stay at the
console. Voice is as capable as the room it is in.

## Herdr runtime

Clankie saves one Herdr binding on first service start: `auto` adopts the
surrounding Herdr session, otherwise starts private bundled Herdr. Later
consoles and service restarts keep that choice. Checkouts need
`pnpm herdr:build` for private mode. `clankie herdr status` distinguishes the
configured choice from the running `active` binding. Change it with
`set --session NAME` (external), `set --runtime bundled`, or `set --runtime auto`
(reselect next start), then `clankie restart captain`.

`clankie-herdr`, `clankie herdr open`, and TUI `/herdr open` attach to the
running local fleet; Ctrl+B then Q detaches without stopping workers. Every
TUI's roster, jumps, and optional board follow the service's binding. Source
socket identity qualifies pane-scoped messages and worker stances.

External mode leaves server lifecycle to its owner and refuses startup if the
selected session is unreachable. `/health` reports owned runtime recovery.
Doctor's `commands.herdr` probes the selected CLI. `commands.herdr-lead` and
`herdrPlugin` describe the optional dashboard integration.
Load `herdr-lead` only when that skill is present. Never run `herdr-lead`
bare or with `--version` — that starts a TUI and hangs the shell. `herdr-lead
state` and `herdr-lead split` are the headless verbs. If the plugin is
bundled and not linked, doctor's `remediations` already has the link command.

## The seat

`clankie seat` opens Claude Code as you, on your person's own plan, with your
tools over the `clankie` MCP server, your persona and memory card injected by
the plugin's hooks, and these skills as `/clankie:this-machine` and
`/clankie:trace-clankie`. Doctor's `laneTools` says whether the service's
`/v1/mcp` route answers; `clankie seat --dry-run` prints the launch plan
(`plugin.source` is `installed` or `plugin-dir`, `channel` says whether wakes
reach that session). The seat's own brain is Claude Code's `/model`;
`clankie model` changes the service lanes. Inside a herdr pane the seat is the
agent named `clankie`, and that pane is your head: the app's Clankie thread
shows its settled turns, and your self-wakes and herdr watches arrive there as
`<channel source="clankie">` events while it is open.

Checkout-only procedures (`verify-clankie`, `release-clankie`, `pnpm check`)
exist only when doctor says `kind: checkout`.
