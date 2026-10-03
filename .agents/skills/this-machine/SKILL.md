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
you are helping. Devices, machines and work trackers are
independent choices. Read `packages/agent-hosts/README.md` under `repoRoot` for current
connection support; do not infer support from the architecture alone.

## One body, several conversations

`clankie body status` shows the stable conversation holding each of Discord
mouth, voice/Go Live, browser and play. Inspecting status grants no control.
Use the current conversation's `body_lease_request` tool to explicitly ask a
holder or queue a notification. Requests expire and never perform an effect
or transfer ownership. Recheck authority and reacquire when notified.
`clankie body request JSON` exposes the same operator API; see `docs/cli.md`
under the reported service root for its exact fields and recovery behavior.
Do not treat expiry or a process restart as proof that a send/session stopped.

## Watching workers

The local console stays in the current terminal. Its live-agent strip uses the
service fleet feed across connected machines: `Ctrl+G`, Up/Down, Enter opens a
worker's existing conversation; Escape returns and leaves its work running.
`Ctrl+Y` from that conversation opens the exact pane in the selected machine's
Herdr workspace. It attaches to an existing server, never starts one. `/agents`
also retains past agents with saved threads. Do not treat a visible working
state or a successful workspace focus as a delivery receipt or model-seen proof;
messages still use native delivery and unconfirmed sends must not be retried
blindly.

## Three cards

| Question                          | Card             |
| --------------------------------- | ---------------- |
| How is this install put together? | `clankie doctor` |
| Are my processes up?              | `clankie status` |
| What am I doing right now?        | `get_self_state` |

Tracked work and its evidence go where each repo already tracks them — load
`work-items` before creating or updating any.

After-the-fact trails (what you said, receipts, play journals) live under the
user's Clankie homes — load `trace-clankie`. Those paths exist on every install.

Plain `clankie` opens the existing main Clankie conversation from any directory.
Use `clankie --chat ID` for another thread, `/new` for a fresh chat, or `/cd PATH`
for a workspace conversation. Reopening the TUI does not reset model context.

## Launcher control

You can restart yourself with `clankie restart` from your own bash tool when
that restart is authorized. The launcher detaches a helper and waits for your
current console or Discord turn to finish; `status: "scheduled"` means it is
queued, not already healthy. Finish your reply so the helper can proceed. Its
`logPath` records the result; check `clankie status` afterward, including Discord.
There is no need to hire a worker, write a delayed script, or ask the owner to
run the command. A worker's backend can share your process lifetime, so handing
it the restart does not make that worker survive. Named service targets are for
an intentionally narrower restart; the normal command needs no extra `clankie`.

This skill is the installed agent companion to the canonical launcher command
layer. Do not write Keychain entries, `~/.config/clankie/clankie.json`, or
`~/.config/clankie/settings.json` yourself. The full flag/JSON/exit-code
contract is `{repoRoot}/docs/cli.md` (every install) and `clankie help` (same
index). Configure through the headless CLI:

| Job                                   | Command                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| This install                          | `clankie doctor` (JSON; exit 0; `ok` means the card was produced)                                      |
| Can he take a turn                    | `clankie doctor` → `captain` (`ready`, or `no_model` / `no_credential`)                                |
| Start at login                        | `clankie autostart status`, `clankie autostart enable`                                                 |
| Are processes up                      | `clankie status` (JSON; `clankie health` is an alias)                                                  |
| Bundled skill classes and selection   | `clankie skills`; also `clankie doctor` → `skills`                                                     |
| Turn opinionated guidance off/on      | `clankie skills opinionated off` / `on`                                                                |
| Exclude/restore an opinionated skill  | `clankie skills exclude NAME` / `include NAME`                                                         |
| Captain + local providers             | `clankie model status`                                                                                 |
| Add a local OpenAI-compatible runtime | `clankie model add-local --id ds4 --base-url http://127.0.0.1:8000 --set`                              |
| Switch captain                        | `clankie model set provider/model`                                                                     |
| Captain effort                        | `clankie effort status`, `clankie effort set high`, `clankie effort clear`                             |
| Cheaper model for everyday turns      | `clankie model routing`, `clankie model routing set provider/model`, `… escalate on`                   |
| When long sessions compact            | `clankie model compaction`, `clankie model compaction set 250000`, `… default`                         |
| ElevenLabs voice model                | `clankie voice status`, `clankie voice model set eleven_v4_turbo`, `clankie voice model clear`         |
| Image / video models                  | `clankie image-model set provider/model`, `clankie video-model set provider/model`                     |
| Persona                               | `clankie persona status`, `clankie persona set --display-name Clankie …`                               |
| Persona images                        | `clankie persona images set <folder>`, `status`, `clear` (restart applies)                             |
| Linear wake rules                     | `clankie linear wake show`, `clankie linear wake set --owner-user-ids ID --actors owner`               |
| Live Linear awareness                 | `clankie linear status`, `clankie linear follow on`, `clankie linear follow off`                       |
| Gameplay availability                 | `clankie games status`, `clankie games set on`, `clankie games set off`                                |
| Non-secret Discord setup              | `clankie discord status`, `clankie discord set --active-body bot …`                                    |
| Herdr session                         | `clankie herdr status --json`, `clankie herdr use NAME`, `clankie herdr create`                        |
| His working directory                 | `clankie workdir status`, `clankie workdir set PATH`, `clankie workdir clear`                          |
| State your assignment (for agents)    | `clankie work-on "Objective" [--repo REPO_ID --issue ISSUE_ID]`, `clankie work-on clear`               |
| Say what you are doing (for agents)   | `clankie stance working --note "…"` (`thinking`, `stuck`, `hauling`, `resting`)                        |
| Public doorway                        | `clankie gateway status`, `clankie gateway set --url URL --host-id ID`                                 |
| Pick up model/provider config         | `clankie restart`                                                                                      |
| Machines / discovery / sessions       | `clankie machines --json`, `clankie machines discover --json`, `clankie machines sessions NAME --json` |
| Pair a device / list / revoke         | `clankie pair --json`, `clankie devices --json`, `clankie devices revoke <id> --json`                  |
| Rotate operator credential            | `clankie operator-credential rotate --json`                                                            |
| Restart / stop a service              | `clankie restart [service]`, `clankie down [service]`                                                  |
| Play session                          | `clankie play status` / `clankie play stop`                                                            |
| Spider-Man gameplay skill             | `clankie rivals status`; `/rivals connect URL` and `/auth rivals-agent` configure it                   |

Everything else about the launcher (Linear inbox, devices, memory, sleep,
steering a turn, model refresh, setup and conflicts) is in
[launcher details](reference/launcher.md).

## Authority

The operator console always has a shell. Discord gets machine tools only for
a system-actor grant; everyone else stays social. Setup wizards stay at the
console. Voice is as capable as the room it is in.

## Reset conversation context

Use `clankie reset --conversation ID` (root: `global-default`) or `/reset` in
its TUI to archive an idle conversation and start fresh context under the same
ID. `/clear` only clears the screen. Reset keeps persona and durable memory,
clears pending conversation goals and watches, and returns an archive ID.
Finish active turns and close side conversations first. An externally bound
root must end its seat first; resetting service storage cannot reset that
harness's context. Full contract: `{repoRoot}/docs/cli.md`.

## Read next, only for the question at hand

- [Launcher details](reference/launcher.md): Linear inbox, devices, memory,
  sleep and doorways, `clankie send`, model refresh, `/setup`, conflicts.
- [Fleet, hires and agent history](reference/fleet.md): `hire_agent` outcomes,
  skill selection, Codex accounts, worker locations, agent conversations.
- [Herdr runtime](reference/herdr.md): which session he uses and changing it.
- [The seat](reference/seat.md): Claude Code or Codex in his operator seat.
- [Hosted Clankie](reference/hosted.md): hosted deployment, managed bodies and
  Discord, a Mac connected to a hosted body.
- [Browser and persona images](reference/browser-and-persona.md).

## Showing current work in the app

A local agent can state its current assignment with `clankie work-on "Objective"`
from its own Herdr pane. Add `--repo REPO_ID --issue ISSUE_ID` to link the exact
registered repo and its existing tracker item; use `clankie work repos` to find
repo IDs. Clear the pointer with `clankie work-on clear` when it no longer
applies. This changes display metadata, not the issue's status or ownership.
The pointer follows the native session through a pane move and service restart;
a new session does not inherit it. Keep transient actions in `clankie stance`
notes. Local Codex `/goal` state appears automatically, including paused,
blocked, budget/usage limits and completion. Remote or unsupported native goal
stores remain unknown. Goal state and busy/idle turn status are independent.

## Agents in the local fleet

`doctor.harnessBridges` reports the worker bridge separately from the operator
seat: Claude plugin installation/enabling, Codex registration and generated config
source, and live local process membership. Use `clankie mcp --fleet` for the
owner-granted tools. Missing tools do not authorize an operator-lane fallback or
another account's Linear connector. Ask the lead/owner to inspect `access list`
and grant only the needed tools with `access fleet default SERVER --tool NAME`.
Fleet grants persist until revoked; `access revoke ID` removes them from running
sessions too. Local discovery carries no bearer. Outward-facing sends still need
the owner's instruction; the connection identity remains Clankie's connected
account. A shared Codex app-server daemon cannot prove its pane; restart Codex in
the pane under the existing daemon-disabled config, then check doctor again.

The console's `/machines` lists discovered machines and their Herdr sessions
before asking for typed names. Named connections apply live. Its session details
manage workspace grants and capacity; choose native harnesses per hire. The
`/herdr` default workspace choice still requires a restart. `/setup` offers that
choice only after doctor finds installed Herdr with running sessions, explaining
that leading the owner's session means seeing and messaging every pane.
