---
name: this-machine
description: Use when asked how Clankie works on this computer, how to set him up, why Discord, voice, models, or credentials are missing, or whether this is a source checkout or an installed release.
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

## Setup: CLI for agents, slash commands for the person

Do not write Keychain entries or `~/.config/clankie/clankie.json` yourself.
The full flag/JSON/exit-code contract is `{repoRoot}/docs/cli.md` (every
install) and `clankie help` (same index). Configure through the headless CLI:

| Job                                   | Command                                                                               |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| This install                          | `clankie doctor` (JSON; exit 0; `ok` means the card was produced)                     |
| Are processes up                      | `clankie status` (JSON)                                                               |
| Captain + local providers             | `clankie model status`                                                                |
| Add a local OpenAI-compatible runtime | `clankie model add-local --id ds4 --base-url http://127.0.0.1:8000 --set`             |
| Switch captain                        | `clankie model set provider/model`                                                    |
| Pick up model/provider config         | `clankie restart captain`                                                             |
| Pair a device / list / revoke         | `clankie pair --json`, `clankie devices --json`, `clankie devices revoke <id> --json` |
| Rotate operator credential            | `clankie operator-credential rotate --json`                                           |
| Restart / stop a service              | `clankie restart [service]`, `clankie down [service]`                                 |
| Play session                          | `clankie play status` / `clankie play stop`                                           |

JSON is on stdout; progress is on stderr. `pair`, `devices`, and
`operator-credential rotate` default to human text — pass `--json`.
`play stop` prints `Nothing is playing.` (not JSON) when idle. A bare
`--base-url` origin is rewritten to `/v1`. `--set` selects the first listed
model. If the probe fails, pass `--models id,id`. Local LLM servers (ds4,
Ollama, LM Studio) are not launcher-owned; start them yourself.

The person at the console can still use slash commands (`/auth`, `/provider`,
`/model`, `/discord`, `/connect`, `/persona`, `/voice`). Those write the same
stores. Secrets still go through `/auth` or the credential broker — never flags.

`credential_unavailable` or `not_configured` means nobody connected it yet. Say
that, and point at `clankie model`, `/connect`, or `/auth`, rather than implying
you refused.

## Authority

The operator console always has a shell. Discord gets machine tools only for
a system-actor grant; everyone else stays social. Setup wizards stay at the
console. Voice is as capable as the room it is in.

## Optional herdr

Doctor's `commands.herdr` / `commands.herdr-lead` / `herdrPlugin` are the
probe. If herdr is missing you can still talk, play, and code; you cannot lead
panes. Load `herdr-lead` only when that skill is present. Never run `herdr-lead`
bare or with `--version` — that starts a TUI and hangs the shell. `herdr-lead
state` and `herdr-lead split` are the headless verbs. If the plugin is
bundled and not linked, doctor's `remediations` already has the link command.

Checkout-only procedures (`verify-clankie`, `release-clankie`, `pnpm check`)
exist only when doctor says `kind: checkout`.
