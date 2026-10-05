---
name: this-machine
description: >-
  Use when operating or configuring Clankie through the launcher CLI, inspecting this
  installation, diagnosing missing Discord, voice, models, credentials, or optional
  integrations, or checking whether it is a source checkout or installed release.
---

# This machine

You are a running Clankie, not a git checkout. Run `clankie doctor --json` and believe
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

The local console stays in the current terminal. Its two-line live-agent dock
below the prompt uses the service fleet feed across connected machines.
`Ctrl+G` opens the full scrolling agent modal; Up/Down selects, Enter opens a
worker's existing conversation, and Escape closes the modal without losing the
draft. Escape from the worker conversation returns and leaves its work running.
`Ctrl+Y` from that conversation opens the exact pane in the selected machine's
Herdr workspace. It attaches to an existing server, never starts one. `/agents`
also retains past agents with saved threads. Do not treat a visible working
state or a successful workspace focus as a delivery receipt or model-seen proof;
messages still use native delivery and unconfirmed sends must not be retried
blindly.

For accepted-issue cost evidence, use `clankie metrics --issue ISSUE --since ISO
--until ISO` or `clankie metrics --issues --worker LABEL`. The operator route
projects retained native history and existing ledgers. Report its `coverage`
alongside token, wall-time, check and rework totals: parent native usage is
partial, elapsed time includes waits, and a passed seat edge is not approval.
Unknowns remain null; never turn missing history into a zero-cost claim. See
`docs/cli.md` under `repoRoot` for window and attribution rules.

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
The console opens at the latest messages. Scroll up to load older retained
history; loading a page preserves the visible text and does not pause live events.

## Launcher control

Landed code is not live until the pinned runtime is updated. From an admitted
machine turn, use `update_runtime` or `clankie update [--ref REF]` to stage a local
Git ref, install and detach a guarded restart. Default is local landed `main`.
`clankie update --ref origin/main` uses the locally fetched remote ref; fetch in
the reported source repository first when current remote code is requested.
Update never fetches, merges or publishes your working branch.

`accepted: true` means pending, not completed. Finish the turn, then read
`runtime_update_status` or `clankie update status` on your next turn and report
the old/new commit and actual health or rollback. The TUI has `/update` and
`/update status`. Never repeat an uncertain update; inspect its existing operation.
A dirty pin or failed install leaves the old runtime untouched.

Social turns cannot update the machine. Older already-loaded MCP bridges may
need their MCP process refreshed to understand newer protocols; repinning files
cannot change running bridge code. A lost tool result is not permission to resend
it, and an HTTP 400 for a missing durable delivery ID must not be bypassed.

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
| This install                          | `clankie doctor --json` (JSON; exit 0; `ok` means the card was produced)                               |
| Can he take a turn                    | `clankie doctor --json` → `captain` (`ready`, or `no_model` / `no_credential`)                         |
| Start at login                        | `clankie autostart status`, `clankie autostart enable`                                                 |
| Are processes up                      | `clankie status` (JSON; `clankie health` is an alias)                                                  |
| Bundled skill classes and selection   | `clankie skills`; also `clankie doctor --json` → `skills`                                              |
| Turn opinionated guidance off/on      | `clankie skills opinionated off` / `on`                                                                |
| Exclude/restore an opinionated skill  | `clankie skills exclude NAME` / `include NAME`                                                         |
| Service model + local providers       | `clankie model status`                                                                                 |
| Add a local OpenAI-compatible runtime | `clankie model add-local --id ds4 --base-url http://127.0.0.1:8000 --set`                              |
| Switch service model                  | `clankie model set provider/model`                                                                     |
| Service effort                        | `clankie effort status`, `clankie effort set high`, `clankie effort clear`                             |
| Cheaper model for everyday turns      | `clankie model routing`, `clankie model routing set provider/model`, `… escalate on`                   |
| When long sessions compact            | `clankie model compaction`, `clankie model compaction set 250000`, `… default`                         |
| ElevenLabs voice model                | `clankie voice status`, `clankie voice model set eleven_v4_turbo`, `clankie voice model clear`         |
| Image / video models                  | `clankie image-model set provider/model`, `clankie video-model set provider/model`                     |
| Persona                               | `clankie persona status`, `clankie persona set --display-name Clankie …`                               |
| Persona images                        | `clankie persona images set <folder>`, `status`, `clear` (restart applies)                             |
| Linear wake rules                     | `linear_wake` (operator only); `clankie linear wake show`, `… set --owner-user-emails EMAIL`           |
| Linear wake chat                      | `clankie linear target show`, `clankie linear target set global-default`                               |
| Live Linear awareness                 | `clankie linear status`, `clankie linear follow on`, `clankie linear follow off`                       |
| Gameplay availability                 | `clankie games status`, `clankie games set on`, `clankie games set off`                                |
| Discord picker directory              | `clankie discord directory [servers                                                                    | channels                      | roles                                              | people] --server ID` (omit server for servers; inspect state/reason before claiming coverage) |
| Shared Discord settings definition    | `clankie discord definition` (host wording, picker/check kinds, Advanced fields; no credentials)       |
| Discord server setup                  | `clankie discord setup`, `… connect --server NAME --role participant                                   | admin`, `… fleet --enabled on | off`, `… tracking --level LEVEL`(see`docs/cli.md`) |
| Non-secret Discord setup              | `clankie discord status`, `clankie discord set --active-body bot …`                                    |
| Explicit Discord test post            | `clankie discord setup test-post --channel NAME` only when the owner asks to post; no automatic probe  |
| Desktop expressions / quiet hours     | `desktop` tool; `clankie desktop status`, `clankie desktop quiet-hours START END TIME_ZONE` / `off`    |
| Minecraft profiles and play           | `clankie minecraft configure`, `profiles`, `status`, `join PROFILE`, `leave`; load `minecraft`         |
| Fleet connected tools / peer messages | `clankie fleet status`, `clankie fleet set --tools off`, `clankie fleet set --peer-messages off`       |
| Native conversation seats             | `clankie claude`, `codex`, `opencode`, `grok` with `--conversation ID`; inspect with `--dry-run`       |
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

Everything else about the launcher (Linear activity, devices, memory, sleep,
steering a turn, model refresh, setup and conflicts) is in
[launcher details](reference/launcher.md).

Discord setup connects one server with Participant or Admin, fleet display and
a tracking level. Participant follows Discord permissions. Admin controls the
dedicated server through `discord_server_action`, including channels, categories,
roles, webhooks and members, without another permission request. The adapter
refuses server deletion and ownership transfer. This role never grants machine
tools. Participant projection posts use the given channel under Advanced;
Admin project mirrors may be channels or forums. `discord_tracking_project`
lets Clankie choose that representation before the first event.

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

## Memory

Use `memory` for selected notes: `action: write` takes `text`, `search` takes `query`,
`edit` takes `id` and `text`, and `forget` takes `id`. Notes stay until forgotten;
no retention flag is needed. Search when the bounded automatic card does not
show what you need. An edit or forget requires the note's own source
conversation; reading a shared note does not give another conversation control
over it. Console notes remain private to the operator lane; Discord notes are
shareable. The host supplies source and visibility.

`/memory` and `clankie memory` are explicit operator management across
conversations. They remain the way to manage older notes without a source
conversation. Person facts still come from your person's `/person-memory`,
not this tool. See `{repoRoot}/docs/memory.md` for the storage and authority
contract.

## Read next, only for the question at hand

- [Launcher details](reference/launcher.md): Linear activity, devices, memory,
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

Service goals require a Pi-owned conversation. Pi's `create_goal` stores an
inactive proposal for the owner to confirm with `/goal accept`; only owner
commands activate it. Native harness MCP seats refuse service `create_goal`
with `native_goal_unsupported`, since the service cannot enforce their goal
continuations or usage. Every service goal has a finite token budget (default
1,000,000; owner override `/goal --tokens <n> <objective>`), including restored
goals. A refused native goal is a boundary to explain, not a cue to start a
second lead through another conversation.

## Presence and desktop body

`get_self_state` reports current activity; `clankie status` reports process
health. Source-derived presence and a desktop expression are separate: the
`desktop` tool can emote, move with normalized display coordinates or show a
short bubble. It publishes an expiring expression, not keyboard or mouse input.
Desktop clients honor quiet hours and macOS Focus; publication is not proof a
client displayed it. For app input, use `desktop-control` or a computer-use seat.

## Agents in the linked fleet

`doctor.harnessBridges` reports the worker bridge separately from the operator
seat: Claude plugin installation/enabling, Codex registration and generated config
source, and live local process membership. Use `clankie mcp --fleet` for the
fleet connected tools. Admitted panes reach verified accounts through exactly
`clankie_tools` and `clankie_call`; the worker plugin adds `message_clankie`.
Search qualified names/descriptions, request selected schemas, then call with
`{name, arguments}`. `clankie fleet set --tools off` stops new standing tool admissions.
A call already past its last asynchronous check can still reach a provider after
`off`; no global in-flight cancellation or concurrency bound is established. The
strict refusal guarantee remains unmet on VUH-1585; see ADR 0217.
Missing tools do not authorize an operator lane or another Linear connector.
Ask the lead to inspect link admission, `fleet status` and the connected account.
Project grants, cwd and native sessions do not gate fleet tools. Projects keep
roles, caps, hiring and tracker binding. Local discovery carries no bearer.
Outward-facing sends still need
the owner's instruction; the connection identity remains Clankie's connected
account. A shared Codex app-server daemon cannot prove its pane. Inspect
`doctor.harnessBridges.linkedSession` for per-pane `missing` / `pane-mismatch`
observations and `unownedBridges` for actual daemon bridge PIDs and inherited
pane claims. Save affected sessions, then the owner can run
`codex app-server daemon stop` and resume each in its own pane with
`codex --no-daemon resume <SESSION>`; keep `daemon_auto_start=false` in the
source-owned config. Do not stop another agent's daemon as a diagnostic step.

For a hand-started Claude/Claude2 pane with `missing`, use that pane's actual
Claude profile: `claude plugin install clankie-worker@clankie --scope user`, then
`claude plugin enable clankie-worker@clankie --scope user`, and restart/resume.
An absent marketplace needs `claude plugin marketplace add
<repoRoot>/integrations/claude-plugin` first. Preserve source-owned settings and
symlinks; use `CLAUDE_CONFIG_DIR` for an alias profile. Verify the fresh native
catalog lists `message_clankie`, `clankie_tools`, and `clankie_call`, then make a
bounded connected-tool read.

Doctor's `linkedSession.nativeBindings` distinguishes observed, recovered and
missing session proof. Local Codex `--remote … resume THREAD` reattachments are
recovered only from the exact retained seat server/socket/thread lifetime.
After an owner-authorized same-thread reattach, `clankie agents readopt SEAT
--conversation ID` repairs the existing owning conversation's occupant binding.
Unread worker output is available through `clankie agents reports --conversation ID`;
reading leaves it unread until the lead acknowledges the fully offered IDs.

The roster's `harnessBridge` flags the same process facts; `Ctrl+G` in the
console reveals the selected pane's full fix. `live-process` verifies process
ancestry/dedicated socket and matching pane/socket environment only, not tools
or reply delivery. `unobserved` means facts are unavailable, never "missing".
The local host observation currently supports macOS; remote/Windows native
acceptance remains separate. Roster samples live for at most five seconds;
explicit doctor reads probe again.

The console's `/machines` lists discovered machines and their Herdr sessions
before asking for typed names. Named connections apply live. Its session details
manage workspace grants and capacity; choose native harnesses per hire. The
`/herdr` default workspace choice still requires a restart. `/setup rooms` offers that
choice only after doctor finds installed Herdr with running sessions, explaining
that leading the owner's session means seeing and messaging every pane.

Retire a workspace explicitly with `clankie project remove-workspace NAME
--workspace PATH`, even if its directory is gone. This preserves roles, caps,
grants and assignments; a tracker-bound workspace must first have its tracker
binding moved or removed. Missing/noncanonical local registrations match nobody
without denying unrelated valid workspaces. For remote approval/removal append
`--machine FLEET_ID --platform windows|posix` and use that machine's exact absolute
path. An approval is never remote process proof or a tool grant.

For missing native fleet tools, inspect `clankie doctor` or `clankie doctor
--machine FLEET_ID`: profile version, enabled state, bridge, hooks and `clankie`
skill are independent facts. Static installation is not live native membership.
The selected remote machine also reports host-observed eligibility per pane,
including actual cwd, native session and hire state. `nativeTools: "not-verified"`
means it has not checked that pane's bridge socket, catalog or reply delivery;
confirm those through the native harness. Unavailable observations stay unproven.
The owner's `clankie harness install` asks per local Claude/Codex profile;
`clankie herdr prepare FLEET_ID` explicitly ships/enables remote profiles.
Updates and checkout/release installs automatically refresh existing links on
this machine and enabled SSH fleets with `clankie harness install --refresh-linked`.
Check its per-profile/fleet receipts: missing managed Codex source setup stays
`source-manager-required`, and a healthy runtime update may still report
`harness-refresh-incomplete`. Owner-approved source setup is remembered for the
same config source. Older native plugin clients get a once-only pane flag asking
the owner to save and restart/resume that harness; nothing is restarted for them.
If `notices.state` is `deferred`, restart flags await an updated service connection.
Generated/symlinked Codex configuration requires its source-owned setup, never
TOML appends. OpenCode/Pi/Grok setup gaps are reported, not silently called ready.

Grok Build native control requires macOS and verified 1.0.46. Review
`clankie seat --harness grok --dry-run`; launch uses the current `GROK_HOME`
and its existing sign-in. Each fresh operator launch creates its own workspace
chat; resume retains the original profile/session/chat after a confirmed exit.
Skills are readable `SKILL.md` paths, not a claimed plugin installation.
Worker hires use a fresh native TUI and its private leader IPC/ACP session.
Queue consumption does not establish a completed model reply. A saved history
without its live controller cannot resume a worker, and pipeline splitting is
unsupported. Inspect an uncertain original pane and receipt before another hire.
Native permission prompts require the owner. Leader mode ignores `--allow` and
`--deny`; an observed enabled direct Linear endpoint refuses before the brief
and asks the owner to disable it in that Grok profile, then start a fresh seat.
Do not change the account/configuration or use a headless/terminal-input fallback
to repair that refusal. See the Grok section of `{repoRoot}/docs/cli.md`.

## Repository-bound worktree roots

An owner may enroll a dedicated root for a repo's future linked worktrees:
`clankie project add NAME --worktree-root ROOT --repo APPROVED_REPO`.
The repo must already be an exact approved workspace in that project. Add
`--machine ID --platform windows|posix` for a registered remote machine.
The service proves canonical paths and native Git registration; a root is never
ordinary folder-containment authority. This changes project membership policy,
not tool grants. Do not run it as a workaround for an unapproved workspace.
Remove only the enrollment with `clankie project remove-worktree-root NAME
--worktree-root ROOT` and the same machine/platform flags. Remove root enrollments
before their repo workspace. Neither command deletes filesystem content.

### Windows fleet tools and native proof

A configured Windows fleet uses a service-owned SSH relay to admit its live
stream and pane for connected tools. Legacy fleet bearers also admit tools,
without proving a pane or mailbox. Loss of the fleet connection denies tools.
Native project, hire and mailbox proof still observes process lifetime, ancestry,
installed executable and actual cwd. Register project workspaces with the fleet's
machine ID; `pc` and `kh2` do not substitute for one another. Native proof does
not gate tools once transport admission succeeds.
See [the trust contract](../../../docs/remote-process-proof.md). Missing native
catalog access still needs a real owner-run pane acceptance check after deployment;
a host observer or isolated relay smoke test does not establish that acceptance.

A stale Claude alias profile may use `herdr prepare NAME` to update only its
existing plugin cache when its settings point to another discovered unmanaged
profile and already enable the shipped plugin. Preparation preserves the shared
settings link and bytes; generated sources or disabled/missing alias plugins
still require the owner's source setup. Read the per-profile refusal before
retrying; never replace a settings symlink to work around it.

Repeated native Claude setup may report "already enabled at user scope" with an
error exit, prefixed by `×` on Windows or `✘` on macOS. Preparation accepts only that exact result after confirming the same
regular profile still enables the plugin; other errors or changed links remain
failures. A setup result is never live tool or socket acceptance.

Windows Codex can be installed even when Node cannot execute its `.cmd` shim.
Doctor resolves only a unique installed native executable from PATH or fixed npm
layouts and reads its native MCP configuration. A legacy Node Clankie bridge
with both Herdr environment variables is a registration, not a missing-plugin
repair instruction. Config inspection never proves the agent's live socket or
tool acceptance; preserve dotfiles-generated config and use its owning setup.

Service-created Windows Codex hires bind their dedicated server's original OS
lifetime to one live native pane/thread. They require the exact worker bridge
shipped with the service; a stale, redirected or changed installation refuses
before the first brief. The owner can update it with `clankie herdr prepare
FLEET_ID`. Hiring does not rewrite the remote profile. The first brief waits for
`clankie_tools` and `clankie_call` while fleet tools are on (neither while off),
plus `message_clankie`. Changed native project/admission state still prevents hire
dispatch; account checks apply when a provider tool is called. An unbound server
confers no native hire or mailbox authority. An uncertain hire is not permission to retry or type into its pane.
