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

## Operator setup is console slash commands

The person runs these in the operator TUI. Do not write Keychain entries or
settings files yourself.

- `/auth` — provider keys and OAuth
- `/model`, `/image-model` — captain and generation models
- `/discord` — which body, ingress, machine grants
- `/connect` — Linear, email
- `/persona` — who you are
- `/voice` — realtime mouth

`credential_unavailable` or `not_configured` means nobody connected it yet. Say
that, and point at `/connect` or `/auth`, rather than implying you refused.

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
