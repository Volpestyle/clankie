# Clankie Claude Code plugin

Workers can use Clankie's connected tools without taking his operator seat:
configure `clankie mcp --grant FILE` using an individually issued private grant.
See [worker access](../../docs/worker-access.md) for account verification,
restrictions and expiry. Fleet membership grants only the explicitly issued fleet tools.

An optional alternative to Clankie's primary TUI lead: his operator seat as a Claude Code plugin
([ADR 0152](../../docs/adr/0152-a-harness-takes-the-operator-seat.md)). Sit in
Claude Code on your own plan and you are talking to Clankie: his identity, the
owner persona, his tools over MCP, the newest memory card on every turn, and
his skills. The service keeps running his body, Discord, voice, and play.

Room handoffs reach a live Clankie head as separate native background agents.
The shipped `agents/room.md` definition (`clankie:room`) permits only the three
`room_task_*` proxy tools. Those tools retain the original room's actor, tool
bank and current grants. The service verifies the actual parent Agent call,
restricted agent type and child journal before accepting calls or showing the
native child reference. The dock and app expose each request's work and result.
An approval-shaped result continues on the authenticated operator surface.
See [ADR 0229](../../docs/adr/0229-room-handoffs-are-visible-parallel-threads.md).

Running Claude Code as a worker in Clankie's Herdr fleet does not require
replacing the lead with this seat. Eligible signed Linear webhooks wake one
configured ordinary global chat, `global-default` by default. Its bound Claude
seat receives the wake through the existing channel; with no bound seat, Pi
handles the turn in that chat.

Like the [herdr plugin](../herdr-plugin/README.md), this carries only what a
plugin can uniquely declare. Everything else lives in the service and the
`clankie` launcher.

## What the plugin carries

| Piece                                                                                                                                                                      | File                       | What it does                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Output style `Clankie`                                                                                                                                                     | `output-styles/clankie.md` | His identity on top of Claude Code's engineering instructions (`keep-coding-instructions: true`); forced on while enabled. Generated from `instructions.md`.                                                                                                 |
| `SessionStart` hook                                                                                                                                                        | `hooks/hooks.json`         | `clankie prompt --lane operator --sections persona,reach,address,model,conversation --harness claude`: the owner persona, reach, address, model card, the recent shared conversation log, and only the project instructions Claude Code does not load itself |
| `UserPromptSubmit` hook                                                                                                                                                    | `hooks/hooks.json`         | `clankie memory-card --lane operator --hook`: the newest memory card once per session, then only its new notes                                                                                                                                               |
| MCP server `lead`                                                                                                                                                          | `.mcp.json`                | `clankie mcp --lane operator`: his tool bank over stdio, bearer read from the broker, never from a config file                                                                                                                                               |
| Skills `/clankie:clankie`, `/clankie:this-machine`, `/clankie:trace-clankie`, `/clankie:lead`, `/clankie:work-items`, `/clankie:desktop-control`, `/clankie:research-team` | `skills/`                  | Links to the shipped skills, available from any working directory                                                                                                                                                                                            |

The output style is generated: edit `apps/clankie/src/captain/instructions.md`
and run `node integrations/claude-plugin/build.mjs`. `node
integrations/claude-plugin/build.mjs --check` fails when the file is stale, and
the launcher's tests run that check.

This source also carries durable operating lessons, including delivery before
harness work, bounded fleet review, and acceptance-driven Linear updates.
The service prompt and this generated seat share them; episode memories are
ambient recollections, not a substitute. New checkout sessions consume the
updated files. Copied release or marketplace installs need their normal update
before new sessions receive the change.

## Launch

```bash
clankie claude            # open a new Clankie chat with the selected skills
clankie claude --conversation ID  # select an existing service project conversation
clankie claude --resume     # reopen the last seat's conversation
clankie claude --dry-run    # print the launch plan as JSON without starting Claude Code
clankie claude2           # use your claude2 shell alias/function for another account
```

Numbered Claude commands load your interactive
`$SHELL` to resolve account aliases and functions.

`clankie claude` needs Claude Code on `PATH` and a TTY. It projects this plugin into
a fresh private directory, linking the same identity, hooks and MCP config with
every shipped skill. A bundled skill whose name is already installed in the
Claude profile's own `skills/` is left out, so the owner's copy wins and each
skill is listed once (plain `claude` only; a numbered command's profile is not
visible to the launcher).

The launcher passes the permission allowlist for `clankie` commands, disables an
older installed `clankie@clankie` for this session, enables the projected
`clankie@inline`, and loads the explicit `server:clankie` development channel.
Claude's [session plugin identity and precedence](https://code.claude.com/docs/en/plugins/loading)
keep the old marketplace skill catalog from leaking into this seat. It starts
with `--name Clankie`. A seat on the global chat names the Herdr pane
`clankie` inside the service's fleet.
`--plugin-dir` chooses the component source; the projection still supplies the
shipped skills. `--dry-run` shows the plugin projection, catalog and private MCP config path.

The seat loads only this plugin's declared MCP servers by default. The launcher
uses Claude Code's documented [`--strict-mcp-config --mcp-config`](https://code.claude.com/docs/en/cli-reference)
with a private per-launch `seat-mcp.json`. Strict mode also omits plugin-provided
servers, so the launcher copies this plugin's declarations into that file: `lead`
is exposed as `clankie`, and other declarations as `clankie-NAME`. The plugin still
supplies identity, hooks, agents and skills. The documented
[`server:` development channel](https://code.claude.com/docs/en/channels-reference#test-during-development)
keeps the same bridge receiving events. The session's
[`disableClaudeAiConnectors: true`](https://code.claude.com/docs/en/mcp#disable-claudeai-connectors)
also prevents fetching the owner's claude.ai connectors. No owner MCP or settings
file is edited; plain `claude` retains its configuration.

Opt in only the configured servers this launch needs:

```bash
clankie claude --mcp-servers blender,pixel-mcp
clankie claude --resume --mcp-servers blender
clankie claude --mcp-servers none --dry-run
```

Names come from the selected profile's user/local `.claude.json` or the
workspace's `.mcp.json`, with local > project > user precedence. Unknown names,
reserved Clankie names and personal Linear servers are refused; tracker work
uses Clankie's connected tools. No inherited project server loads automatically.
This is a per-launch allowlist: repeat it on resume; `none` is the default.
For a numbered account alias, set `CLAUDE_CONFIG_DIR` to that alias's profile
when resolving named opt-ins. Credentials in copied definitions stay in the
private launch file, rather than in argv or dry-run JSON.

### What the scoped launch retains

The launcher still passes `--plugin-dir` and enables `clankie@inline`. Strict
mode scopes MCP, not the rest of the plugin. The plugin forces its `Clankie` output style;
native 2.1.310 includes it in a request message reminder. The output style,
SessionStart/UserPromptSubmit/Stop and other hooks, room agent and selected
`/clankie:*` skills remain loaded. The bridge uses the existing bare
`server:clankie` development-channel route for `watch`, `wake` and `message`
events. Its launcher-supplied `CLANKIE_SEAT_HARNESS`, `CLANKIE_SEAT_SESSION_ID`
and selected `CLANKIE_CONVERSATION_ID` retain the operator seat's binding.

The tool prefix changes from `mcp__plugin_clankie_lead__*` to
`mcp__clankie__*`. The launch permissions allow only the new server prefix; obsolete plugin-prefix
allow rules are removed from this launch's settings. User-owned rules are never
edited. The room agent already
allows both names. The tracker hook's matcher identifies external Linear server
names, so it still allows Clankie's `linear_*` tools under the new prefix. The
native catalog observer tries the plugin's `lead`, then the bare `clankie`
registration. The generated output style names the scoped server and its direct
plugin alias; historical captures retain the names they actually observed.

The repository prefix audit covers these remaining references:

| Surface                                                                                                             | Disposition                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Launcher settings and seat/joined-seat tests                                                                        | Allow `mcp__clankie`; assert the explicit server and channel.                                                                                    |
| `agents/room.md`                                                                                                    | Already permits new and both older plugin prefixes; retain compatibility with direct plugin sessions.                                            |
| `hooks/hooks.json`, tracker-hook integration test                                                                   | Server-name Linear matcher remains valid; test permits both old and new Clankie tool names.                                                      |
| `worker/mods/tool-catalog.mjs` and its generated hook copies                                                        | Derive the actual namespace from `lead` or `clankie`; no fixed tool prefix to replace.                                                           |
| `build.mjs`, generated `output-styles/clankie.md`                                                                   | Footer now names scoped `clankie` and direct-plugin `lead`. Captain `instructions.md` and the generated Codex seat have no old-prefix reference. |
| Shipped skills and `docs/cli.md`                                                                                    | Seat reference and CLI explain the new scope, prefix and binding. Other shipped skills have no old-prefix reference.                             |
| `command/mcp.ts`, `mcp-bridge.test.ts`, `fixtures/seat-pump-stdio.ts`                                               | Retain old channel aliases/fixture; bridge integration now covers `server:clankie` too.                                                          |
| `eval-runner.test.ts`, `native-room-handoff.integration.test.ts`, `room-handoff-native-captain.integration.test.ts` | Old tool-name fixtures exercise supported legacy native journals; retained. No eval was run.                                                     |
| `docs/verification/vuh-1887`, `docs/testing/VUH-1859-idle-claude-delivery.md`                                       | Historical observations retain their measured names. This README and VUH-2815 evidence describe the migration.                                   |

A read-only audit also found one owner rule, `~/.claude/settings.json` →
`permissions.allow[5] = "mcp__plugin_clankie_clankie"`. It belongs to the owner
and was reported to the lead without editing it. The replacement rule is
`"mcp__clankie"` in `permissions.allow`. Seats launched by `clankie claude`
retain pre-approval through the launcher's session rule, so the rename adds no
permission prompt there. Existing running seats and direct-plugin registrations
keep their names. A session manually reusing the new explicit config without the
launcher settings no longer receives pre-approval from that old owner rule:
normal permission policy applies (a prompt when approval is required), while
bypass mode shows no prompt. The owner may choose whether to add the replacement;
the launcher does not migrate user settings.

### Binding and the known unbound-bridge gap

The generated `clankie` declaration appends `--conversation` with
`${CLANKIE_CONVERSATION_ID:-}`. The launcher supplies that environment variable.
Reusing the generated file without it expands the argument to an empty string,
which the MCP CLI refuses before connecting. `--dry-run --new` describes a chat
that has not been created yet; its generated file needs the real launch binding
before it can serve tools.

The new file is a convenient bare-server artifact in a private 0700 launch
directory, mode 0600. It contains no operator bearer by default, but a same-user
process could deliberately supply a conversation and invoke it. The bridge's
binding check below uses kernel process facts and a bridge-only nonce. It is a
guard against strays, not an authority boundary against a hostile same-user
process that holds the operator bearer and can launch its own child.

In enforcing releases, an operator bridge acts as the lead only for the process its launcher
registered ([VUH-2816](https://linear.app/vuhlp/issue/VUH-2816)). The service
used to answer a request with no conversation from the owner's `global-default`
lead chat, and the bearer plus a free-text `conversationId` named no caller, so
a stray with the clankie server in its MCP config (or a `clankie mcp` started in a
seat's shell, inheriting its environment and ancestry) polled, acknowledged and
messaged as the lead. VUH-2888's preparation release runs these checks in
**observe** mode, preserving admission for old launchers while recording their
refusals. Doctor inventories live local launchers and gives exact-session
recovery. The subsequent enforcing update requires every seat to be bound;
unknown inventory holds it. Follow the [migration commands](../../docs/cli.md)
before enabling enforcement. The enforcing checks are:

- **The launcher registers.** After spawning the harness, `clankie claude` (and
  the codex, opencode and grok launchers) `PUT /v1/captain/seat-bindings` with
  the conversation, the harness pid and a hash of a per-launch nonce. The
  service takes the launcher's identity from the kernel's owner of the request's
  TCP socket (the same native helper the local-fleet proof uses), never from the
  body, and records pid plus kernel birth time. The existing native pair census
  must also prove the named harness is a direct child of that socket owner,
  with matching live births. An unrelated bearer holder cannot nominate the
  genuine harness, including after service restart before heartbeat. It
  re-registers every few seconds and attempts withdrawal on exit. An HTTP or
  transport failure to withdraw emits a warning without masking the harness exit;
  process lifetime checks still refuse a dead launcher.
- **Conversation authority belongs only to that bridge.** `/v1/mcp` with an
  explicit conversation, `GET /v1/seat/events`,
  and the events `ack` and `reply` routes admit an operator-lane request only
  when the socket's owner is the harness's **direct child** (or, for a launcher
  that spawned a shell first, the one registered extra hop), presenting the nonce
  in `x-clankie-bridge-claim`, or is the registered launcher itself for its
  pumps. The conversation must be named: there is no `global-default` fallback.
  A stray nested under the genuine harness or its shell, a wrong conversation, a
  reused pid (births differ), a dead launcher, a second live claimant and a
  caller with no provable socket are all refused with a typed `seat_*` error.
- **Stateless bearer tools keep working.** HTTP `/v1/mcp` with no conversation
  creates no conversation context, so ordinary `clankie linear` read/graphql/
  post/catalog calls retain their bearer access. Lead tools return a typed
  `conversation_binding_required` refusal; they cannot inherit `global-default`,
  offer or acknowledge reports, message seats, or reconcile a lead's receipts.
  Naming a conversation still requires the native launch proof above.
- **The bridge refuses early.** Without a selected conversation it exits with a
  diagnostic before reading the credential or contacting the service.
- **Where the nonce travels.** Claude: only in the per-launch 0600
  `seat-mcp.json` MCP entry. Grok: only the ACP `mcpServers` environment.
  Codex and OpenCode: a private 0600 nonce file; only their MCP server config
  receives `CLANKIE_BRIDGE_NONCE_FILE`. Codex disables the plugin's `lead`
  transport and supplies a native `mcp_servers.clankie` entry; OpenCode's
  plugin preserves that explicit server environment. The harness environment
  and argv contain no nonce bytes, and inherited claim variables are cleared.
  `--dry-run` creates no nonce and prints none. The file reader refuses symlinks,
  public permissions, wrong owner, wrong size and malformed claims.

Expected process chains (source candidate; native model harness launches remain unproven):

| Launcher  | Registered child and expected bridge chain                                    | Remaining gap                                                                                                                                                                                                                                                                                                                                  |
| --------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude`  | launcher → Claude → MCP bridge; depth 1                                       | A node/npm wrapper that adds another process needs native confirmation.                                                                                                                                                                                                                                                                        |
| `claudeN` | launcher → interactive shell → Claude → MCP bridge; shell registered, depth 2 | Shell alias/function and node wrappers can add hops. A depth-2 claim permits this exact distance; it does not prove which wrapper binary ran.                                                                                                                                                                                                  |
| Codex     | launcher → app-server → MCP bridge; app-server PID from `onServerStarted`     | An npm shim spawning the native binary can add a hop; no real app-server launch was authorized.                                                                                                                                                                                                                                                |
| OpenCode  | launcher → OpenCode → MCP bridge                                              | Plugin-host/wrapper parentage and native config consumption need real harness confirmation.                                                                                                                                                                                                                                                    |
| Grok      | launcher → ACP agent → MCP bridge                                             | ACP child PID is registered; native wrapper ancestry needs confirmation.                                                                                                                                                                                                                                                                       |
| Prime     | daemon → Python kernel → MCP bridge                                           | **OPEN:** no launcher-visible kernel PID, so local operator bridge is refused. Needed native interface: return the kernel PID for this exact launch, with its kernel lifetime and launcher/daemon launch correlation; the service must independently observe that lifetime and verified launch edge. A bare self-asserted PID is insufficient. |

Limits and caller routes:

- An operator-bearer holder can launch its own child and race to register an empty
  conversation. The direct-child check prevents unrelated-PID squatting, not this
  same-user impersonation or a hostile user reading private nonce files. Do not
  call a self-asserted launch authenticated. Existing `seat-context` selects or
  creates conversations but issues no launch ticket. Fleet/remote launch intent
  belongs to admitted native hires/delegations, not free local operator launches;
  this repair reuses their native census rather than inventing blanket authority.
- The registry is in service memory. After restart, old bridges refuse until
  the genuine launcher's heartbeat succeeds. A different live controller yields
  `seat_binding_conflict`; do not terminate another seat to clear it.
- Joined/remote leads use their existing machine token and `seat.authorize`
  delegated `/v1/fleet/lead/*` route, outside this local kernel registry. Their
  local `/v1/mcp` and binding routes refuse. Device relay allowlists owner
  dispatch/tail routes and excludes local MCP/binding registration. Owner-app
  turns still use owner dispatch. Legacy bearer-only owner-update MCP is refused;
  a registered seat uses the normal bound MCP path. Permissive retry fixtures
  prove only behavior after admission, never real consumers or launches.
- `POST /v1/seat/transcript` and prompt/memory reads remain bearer-only.
- Fixtures prove real native Node launcher/harness/bridge process chains and
  HTTP/socket admission, not real Claude, Codex, OpenCode, Grok or Prime launches.
  Full original real-operator acceptance remains open pending those checks.

`clankie doctor` reads `GET /v1/captain/seat-bindings`: helper availability,
registered conversations and the last refusal/recovery; no claim or hash is
returned. A last refusal stays in the report body and never replaces a live
finding in the doctor headline. The normal `seat_binding_required` startup
window is not retained; successful registration or admission clears the last
refusal for that conversation. The bridge retries `seat_binding_required` and
`seat_binding_stale` within the same bounded startup window: a dead prior
launch is removed before the new launcher's PUT arrives. Wrong ancestry, nonce,
conflict and an existing claimant remain final refusals. Startup and
registration errors preserve the precise reason: `seat_binding_helper_missing`
(prepare/repair the native helper), `seat_process_unproven` (use a direct IPv4
loopback socket and inspect the helper), `seat_harness_not_child` or
`seat_bridge_not_registered` (wrong launch chain), `seat_bridge_claim_invalid`
(recreate the private MCP config), and `seat_bridge_claimed` (another bridge
holds the launch). Relaunch only the seat you own; do not copy claims or restart
the real service as a diagnostic workaround.

#### Reports a stray session consumed

A stray that acknowledged a report marks it read in the lead conversation's
inbox, so the real lead's `worker_reports` no longer lists it. Read reports are
pruned from the conversation file a day after they are read
(`READ_REPORT_RETENTION_MS`), and an exact-ID status then reads as unknown, so
the retained record may or may not still exist. Recovery reads existing evidence
and creates no new delivery:

1. Read the stray session's own transcript (its Claude profile's project log);
   it holds the report text it received and anything it sent.
2. Read the retained store record for the exact delivery ID, if the day has not
   passed or the file was not yet rewritten, and the exact-ID status.
3. Read what the worker itself wrote on the tracker issue it reported on.

Never replay, resend, re-acknowledge or edit a retained or uncertain report: a
duplicate delivery or a second acknowledgment is a new effect. If the stray also
messaged a worker as the lead, tell that worker (through the real lead) which
instructions were not the lead's.

`--conversation ID` resolves an existing global/workspace or Discord room conversation through
`GET /v1/captain/seat-context`, starts Claude in its service-owned workspace and
binds the prompt, MCP tools and channel to that conversation. The selected
workspace must exist on the native host. `--resume` retains the binding and
refuses a different ID. Without a selection, a fresh launch takes the shared
global chat while no live seat holds it (`GET /v1/captain/seat-context` reports
`occupied`); otherwise, or with `--new`, it creates its own workspace chat through
`POST /v1/captain/seat-context`. Its transcript, tools and wake channel belong to
that chat. `--resume` reopens the last seat and its chat for the selected Claude
command; `--conversation global-default` selects the shared global chat even while
another seat holds it. Workspace seats do not claim the global Herdr head name.
`--dry-run` describes the chosen or new conversation without creating it.

The launcher sets `CLANKIE_CONVERSATION_ID` for the plugin's hooks and MCP bridge;
inherited selections and worker capabilities are cleared. The prompt adds
the selected workspace's agent instructions through the same resource loader Pi
uses, with source paths, plus the owner's persona and fleet preferences. The
memory card remains the operator lane's shared recall; it is not project-filtered.
Pi and native leadership share task ownership and grant authority. Each selected
conversation has its own channel outbox, so its messages and replies stay in that
conversation. A bridge without a loaded Claude channel serves tools without
consuming events; queued work stays with the service.
Claude Code's interactive session receives channel events. Its `--print`/`-p`
mode serves MCP tools and transcript hooks but does not consume the outbox,
because that mode does not register channel notifications.
Without an available execution runtime, peer communication remains usable. The
plugin's operator bearer belongs to this trusted seat; it is not a worker credential.
Scoped access for other workers is tracked in the
[worker access contract](../../docs/worker-access.md).

The bundled seat needs no marketplace installation. If an older seat plugin is
installed, leave it disabled at user scope: its forced style otherwise applies
to ordinary Claude sessions too. The launcher only changes session settings.

```bash
claude plugin disable clankie@clankie  # if previously installed
clankie claude --dry-run                # projected plugin, selected skills, channel: true
```

In the session, `/mcp` lists the `clankie` server, `/clankie:this-machine`
loads his install skill, and `clankie model status` runs without a prompt.

## Worker channel plugin (`clankie-worker`)

[`worker/`](worker/) is a second plugin in the same marketplace,
Current Claude Code (mods support, 2.1.287 or newer) checks its accepted Clankie
tool catalog after native session start through a trusted plugin module. It uses
the native server namespace, reports only that session's tools through the pane
link, and shows a mismatch with one fixing action. The same verdict appears in
the roster and `clankie doctor`; a live bridge process alone remains separate
evidence. Operator and worker bridges report independently. Plugin reload,
clear, resume and compaction trigger a fresh check. No native evidence stays
explicitly unverified. The original interactive mod also observes the accepted
catalog every five seconds while idle, after Claude's native MCP
`tools/list_changed` handling, and reports it only when it changes. Each report
costs Clankie fresh process proofs, so an unchanged catalog he accepted is resent
only every five minutes, which restores his in-memory verdict after a service
restart (VUH-2062). A refused or failed report retries with backoff as before.
Running turns, tools and background agents hold these probes. Reports keep the
exact current session and server namespace;
they never submit a prompt, create an SDK query, reconnect personal servers or
restart the seat. A missing native mod/API remains an explicit failure in
`clankie harness refresh-tools` and the roster. See
[doctor](../../docs/cli.md#doctor).

`clankie-worker@clankie` serves native hired seats and linked fleet agents.
Its MCP server key is `clankie`; older `swarm` registrations require updating.
it runs the native seat mailbox or fleet link, with no coordinator runtime.

- **Clankie hire** (VUH-1458): inside the hire's herdr pane it runs
  `clankie mcp --seat`, so the seat's mailbox (brief, `message_seat`, DMs)
  arrives as channel events. The bridge polls only when the Claude session that
  launched it loaded `plugin:clankie-worker@clankie` under `--channels`.
  The wrapper's `CLANKIE_SEAT_PARENT_ARGV` identifies that plugin bridge. A
  separately registered `clankie-seat` bridge cannot consume its mailbox just
  because Claude loaded the plugin; it needs its own selected channel.

- **A machine in one of his ssh fleets** (VUH-1527): when
  `~/.clankie/link.json` exists, the same channel and hooks run in plain Node
  over that machine's link to Clankie, with no `clankie` CLI or operator
  credential there (`bin/seat-channel.mjs`, `bin/link.mjs`). The link's token
  only reaches the seat routes of that fleet's panes. Windows reads the
  launching session's command line from the process table instead of `ps`.
  `clankie herdr prepare NAME` ships this plugin there as a `clankie`
  marketplace holding only the worker, installs it disabled, and approves its
  channel in that machine's managed policy.

In a herdr pane the server also offers `message_clankie`: any agent
there, hired or not, can write to Clankie first. He receives it as that agent's
output, never as the owner's instruction, and answers with `message_seat`;
with a live channel the answer arrives immediately. A hand-started session with
an observed worker hook can instead receive the answer as additional context on
its next `UserPromptSubmit`, without `--channels`. Clankie binds held mail to
that native session and terminal, keeps it for at most 24 hours, and hands it
to the hook once. A replacement occupant cannot take the old mail. An uncertain
HTTP or output-pipe handoff is retained as a receipt, never replayed. A successful
hook output acknowledgment means `delivered`, not model consumption.

Each channel poll and ack passes a native process proof, which can take
seconds or refuse under fleet load. A worker mailbox therefore stays bound for
15 seconds between polls and waits 30 seconds for an event's exact ack. The
bridge retries that same ack for up to 20 seconds and keeps polling once it
lands (VUH-2034). It stops polling only when the ack names another event or
never lands. A roster that shows the seat as not `live` is then accurate.

An expired poll binding does not mean the owner took over. Claude's native
work status and Stop hooks remain watchable while live channel delivery is
unavailable. Subagent UI changes and `UserPromptSubmit` are not owner-input
evidence: [Claude also fires that hook for background subagent reports and
scheduled turns](https://code.claude.com/docs/en/hooks#userpromptsubmit).

The fleet roster's `messageReceiver` separates inbound delivery from installed
tools and outbound reports. `next-turn-only` means a prompt hook is observed for
this exact session but no live channel poll is bound; `live` means a native poll
is bound, and `unverified` means neither receiver is observed. These are current
observations, not model consumption or a permanent capability verdict. The TUI
flags next-turn-only leads even before mail is queued, and a stored adoption or
message receipt also warns. Its detail includes
`claude --resume SESSION_ID --channels plugin:clankie-worker@clankie` for the
original session. Coordinate any stop/reconnect/resume with the owner, preserve
its original cwd and account/config home, and never start a duplicate session.
Installing a new plugin cannot enable channels in an already-running process.

Clankie’s Claude hire enables the plugin for that session (`enabledPlugins`) and
starts Claude Code with `--channels plugin:clankie-worker@clankie` for immediate
delivery. In prepared Mac zsh panes, Clankie's [PATH shim](../herdr-plugin/README.md#hand-started-claude-on-mac)
adds the channel to plain `claude` and `claude --resume ID` when the worker
plugin is enabled. Explicit channels and settings always win. Other unprepared
hand-started sessions without that flag use their observed synchronous prompt hook, which
receives held replies on the next turn. A session without an observed compatible
hook or live channel has no reply receiver. Its hooks (`SessionStart`, `UserPromptSubmit`,
`Stop`, `StopFailure`) report through the matching local or remote fleet link, so
Clankie learns each settled turn and its final text.

Claude Code only runs a non-official channel plugin unattended when the owner's
managed settings allow it. That is the owner's action, never the dispatcher's:
the exact `allowedChannelPlugins` entry and probe are in
[managed consent](../../docs/testing/2026-09-26-interactive-swarm-workers/managed-consent.md).
Install it disabled, like the seat:

```bash
claude plugin install clankie-worker@clankie
claude plugin disable clankie-worker@clankie
```

Until both steps are done, a Claude hire reports `consent_required` with the
missing step and unavailable control. It does not type the brief into the
terminal or launch a replacement worker.

Fresh hires stage the brief in a private JSON file and take it once through a
short native CLI startup prompt referencing that file. Settings and inline
system/config text also use native file forms;
the channel carries resumed briefs and follow-ups. A stdout ACK alone cannot
confirm prompt acceptance: the exact native transcript must contain the complete
decoded file attachment (or whole channel brief for a resumed session). Missing evidence stays uncertain and must not trigger a replacement send.
A follow-up that reaches a working Claude whose session already took a channel
event reports `queued`: Claude records it only at its next pause between steps
(VUH-2779).
The observed session retains its hiring conversation when startup fails, with a
persisted roster failure summary and a wake to that conversation.

With consent approved, a briefed local Claude hire reports `control.mode: "channel"`,
including when other execution fleets are registered. Every hire logs its lane;
unavailable control includes `control.reason`. A folder-trust prompt reports
`trust_required` and remains visible in its pane for the owner. Uncertain startup
or delivery must be inspected before retrying. See
[native delivery](../../docs/adr/0207-work-records-and-native-agent-delivery.md).

Workers use their harness's native interactive TUI. Local Claude hires and linked
fleet agents use a live worker channel or the observed Claude next-turn hook.

## Codex

Codex is not a Claude plugin. It takes the same `clankie mcp --lane operator`
entry in its MCP config and the same skills directory; the seat is the tool
bank, not the harness.

## Troubleshooting

| Symptom                                    | Fix                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| He answers as Claude Code                  | The seat was not launched by `clankie claude`, which enables the plugin for its session    |
| Every Claude Code session answers as him   | The plugin is enabled at user scope; `claude plugin disable clankie@clankie`               |
| `/mcp` shows `lead` failed                 | The service is down or the operator credential is missing: `clankie status`                |
| `lead` refused: no verified seat binding   | The bridge was not launched by `clankie claude`; launch the seat that way (VUH-2816)       |
| No persona or memory card at session start | `clankie` is not on the hook's `PATH`; `pnpm cli:install` symlinks it into `~/.local/bin`  |
| Wakes never arrive                         | The seat was loaded with `--plugin-dir`; install from the marketplace for the channel flag |
| `claude plugin validate --strict` warns    | The skills are symlinks by design; sessions follow them, validation does not               |

## Native transcript projection

Launched seats publish settled messages and tools to their selected Clankie
conversation through `clankie seat-sync`. The Stop, StopFailure and PreCompact
syncs run `async`, so projection never adds latency to the seat's turns. Native hook activity settles the app
after a stop, including when transcript records arrive after the channel reply.
This works outside Herdr and with
`--plugin-dir`; it does not require the Claude channel preview. The hook reads
and redacts on the Claude host, while the service deduplicates retries and pins
the native session to one conversation. Ordinary plugin use without the launcher
session binding does not publish. See [CLI sync contract](../../docs/cli.md#native-seat-transcript-sync)
and [Claude hook input](https://code.claude.com/docs/en/hooks#common-input-fields).

### Memory card injection

Claude Code keeps every hook injection in the conversation, so an unchanged
card printed each turn would only pile up copies. With `--hook`, `clankie
memory-card` reads the hook's `session_id` from stdin and prints the card on the
session's first prompt, then again only when its content changes (a new or
corrected episode). A sha256 of the last card each session saw lives in
`$TMPDIR/clankie-memory-card/`. `SessionStart` (startup, resume, `/clear`,
compact) clears that record so the next prompt injects the card again; this
covers compaction summarizing the earlier copy away. Input without a usable
`session_id` gets the card every turn, as before.

### Hook latency

Memory and transcript hooks read the operator bearer without waiting behind an
unrelated Keychain OAuth refresh. Transcript uploads share one ten-second HTTP
budget across all pages; the next hook retries retained records if an upload
fails. The memory-card request also has a ten-second HTTP timeout. These budgets
start after credential lookup and do not bound CLI startup or native transcript
parsing. Claude gives each hook 60 seconds overall to allow CLI startup and scheduling
on a loaded machine. Raising that outer limit alone does not fix credential contention.

### Service restarts

The operator bridge renews its MCP session after an explicit `unknown_session`
rejection before tool admission and retries that rejected request once. Concurrent
requests share the new session. Old HTTP clients drain without closing pending
calls when another request reconnects. Network failures and lost tool results
never replay a pending action because the tool may already have run.

Before protected `message_seat` or `hire_agent` dispatch, the bridge assigns a
`deliveryId` or `hireId` in MCP `_meta["clankie/seat-call"]`; the service persists
the receipt before the native effect. Lost results return typed uncertainty with
the original ID. Use read-only `reconcile_seat_call({deliveryId})` or
`reconcile_seat_call({hireId})` from the owning operator conversation to inspect
that receipt. This never resends a message or starts a replacement hire. Settled
receipts survive restart within bounded result-body retention; original IDs
remain non-replayable, and uncertain originals remain retained. These
operator call receipts are separate from the fleet peer-message ledger. See
[ADR 0207](../../docs/adr/0207-work-records-and-native-agent-delivery.md#mcp-reconnect-and-native-call-receipts-vuh-1638).

Bridge stderr records `upstream_error`, `upstream_retired`, `upstream_closed`
and `upstream_reconnected` with the client generation and pending-call count.
`stdio_closed` identifies the harness closing its bridge. These diagnostics
distinguish a replaced HTTP client from a closed stdio connection; they contain
no tool arguments or response bodies. Restart an older MCP bridge to load them.

Persisted Herdr watches retain their stable terminal
identity when a wait process fails, retry observation, and resume on service start.
A failed wait is not treated as agent completion.

An already-running bridge must be reloaded once to pick up this implementation:
reconnect the plugin's **operator** MCP server (`clankie mcp --lane operator`),
not only the separate fleet mailbox (`clankie mcp --seat`).

The seat denies every inherited Linear MCP connector (any server on Linear's
host or named for it, in user, local or project scope, plus the claude.ai Linear
connector), whose identity may differ from the owner-connected account. That connected tracker identity is
Clankie’s and his whole fleet’s identity. Tracker writes use Clankie’s connected
tools or a granted worker bridge; a worker lacking access asks the lead to write.
Eligible signed Linear activity wakes one ordinary configured chat, `global-default`
by default, through its existing native seat channel when attached. The lead
chooses any delegation. Wake rules and the target are non-secret settings.

### Persona image folders

The output style and SessionStart hook carry text. When the owner selects a
[persona image folder](../../docs/persona-images.md), `clankie prompt --sections persona`
includes its cached visual description. Automatic image prefix injection is
available in Pi sessions, not in this Claude Code seat. The seat's `generate_image`
MCP tool still accepts `personaReference: true` to use only the owner's `appearance/` references for
self-depiction. Top-level images and sampled video frames supply vibe, never
physical appearance; the caption preserves that distinction. A restart of Clankie applies changes to the board.

### Owner installation across profiles

`clankie harness install` offers consent for each discovered local Claude profile
and native Codex worker plugin. `clankie herdr prepare NAME [--codex-source-setup ABSOLUTE_REMOTE_SCRIPT]` explicitly installs
and enables the worker for hand-started and hired agents across remote Claude
profiles, including `CLAUDE_CONFIG_DIR` and named `~/.claude-*` directories.
The worker MCP server is `clankie`. Bump both worker manifests on every shipment,
including Claude mods and report helpers, so native caches cannot retain older
bytes at the same version. A changed marketplace file with an unchanged manifest
version is not proof that an installed native cache received the change.

Updates and checkout/release installers run `clankie harness install --refresh-linked`
for existing local profiles and enabled SSH fleet machines, without enrolling new
profiles or changing channel policy. Native plugin managers refresh caches and
retarget a recognized local marketplace when an immutable release path changes.
Previously approved managed Codex source setup is reused for its exact config
source. Missing source setup stays an incomplete receipt. Running native clients
report the version captured at plugin process start; an older version gets a
once-only Herdr restart/resume flag, without controlling the pane.

`clankie doctor [--machine NAME]` compares deployed versions with the service and
reports bridge, hook and `clankie` skill presence separately. Native Codex worker
packaging lives beside the Claude packaging in `.agents/plugins/marketplace.json`
and `worker/.codex-plugin`; it reuses the fleet bridge, has no operator bearer and
does not advertise Claude hooks as Codex receivers. Managed Codex configuration
must go through its real source/setup. Remote preparation can invoke the explicitly
selected source-owned script; it receives the prepared marketplace and native
executable without rewriting the managed link. The dotfiles `codex-worker-setup.py`
installs through native Codex using a temporary regular config with access to the
runtime plugin cache, then renders only its owned worker selection. Missing native
worker checks make preparation fail even if a legacy MCP registration exists.
Live membership and reply delivery require
native session proof; installation alone supplies neither.

### Working beside Clankie

The `clankie` skill teaches native fleet agents how to use fleet connected tools through the two-tool bridge,
check their connected actor, inspect conversations and sessions, and interpret
delivery receipts. Its authored source is `.agents/skills/clankie/SKILL.md`.
The operator Claude plugin links it; `worker-skills` links the canonical catalog.
Codex installation needs regular files, so its build materializes the catalog.
The worker package contains regular `skills/clankie/SKILL.md` and
`skills/fleet-resources/SKILL.md` snapshots, shared by its Claude and Codex
manifests. The companion teaches local heavy permits and simulator leases. The operator and
worker `PreToolUse` Bash hooks carry each native session/subagent’s holder identity
in `CLANKIE_RESOURCE_HOLDER` plus `CLAUDE_SESSION_ID`/`CLAUDE_AGENT_ID`, scoped
to a subshell for that command, clearing an ancestor Codex thread ID. The resource
CLI derives the holder from current native metadata and ignores inherited holder
labels. Hire allocation clears these fields in new panes, even when the Herdr
server inherited an operator's environment. A persistent Bash session cannot retain one child’s
export for a sibling. Worker 0.6.18 and operator 0.3.7 give the hook changes new cache versions;
doctor/native setup also require its Bash resource hook, not just lifecycle hooks.
Existing sessions must use their native hook reload before new definitions apply. They preserve tool fields
and leave permission decisions to Claude. The resource CLIs use it for independent
simulator ownership and named heavy holders; they do not write a shared env file.
From worker 0.6.19 and operator 0.3.8 (VUH-2390) Claude starts that hook only for
a Bash call with a command word `clankie` (`"if": "Bash(*clankie *)"`; compound
commands it cannot split still run it), so name `clankie heavy` or
`clankie simulator` in the command itself. A script that calls them internally
has no native holder and is refused: pass `--holder`/`holderId` there. The
Linear connector guard starts only for an MCP server whose name contains
`linear`, matched case-insensitively, and still denies every one of them.

Before a checkout worker install or fleet copy, the existing Codex materializer
refreshes every bundled skill snapshot (`clankie`, `fleet-resources`,
`work-items`, `work-orient`; `WORKER_SKILLS` in `skill-bundle.mjs`). Release
assembly does the same.
`node integrations/claude-plugin/worker/bin/skill-bundle.mjs` builds them manually.
Each has a separate `skills/NAME.bundle.json` recording its content SHA-256 and
worker version. A standalone package validates every regular snapshot without
importing a repository or builder. An older package missing a snapshot must be refreshed
from the complete artifact; replacing the helper alone is refused. This does not
refresh a running harness or its plugin cache.
Doctor checks the installed skill marker separately from native membership.
Shipping or loading the skill grants no tools and is not a live delivery check.

### Structured worker questions

The worker plugin forwards synchronous `PermissionRequest` hooks and
`PreToolUse` hooks matching `AskUserQuestion`. The service binds each request to
the observed worker pane, native session, tool invocation and hook event, then
projects its options into the hiring conversation. The lead answers through
`message_seat.questionAnswer` with the exact request and question IDs. An
owner-reserved decision uses the existing owner ask/escalation path.

A permission answer returns `hookSpecificOutput.decision.behavior` as `allow`
or `deny` for that invocation. An ask-the-user answer returns a `PreToolUse`
`allow` plus `updatedInput.answers`, keyed by the original question text.
No pane typing is involved. Answers are single-use; a closed session, timeout,
replayed invocation, or resolved request refuses another answer. Hooks wait up
to ten minutes; the service retires its live request earlier. Bridge failures
preserve the native prompt rather than asserting an answer was delivered.
These command hooks belong to the worker package, independently of the
operator seat's context hooks. Refresh the normal plugin installation for new
sessions to consume them; this change does not restart existing lanes.

New local hires retain tracker denies and explicitly ask for edits, writes,
Bash and network calls. Broad native allow rules cannot express the semantic
owner gates safely, so the hook routes their questions using effective policy.
Unclassified permissions, including shell commands, stay owner-only; file-tool
questions use the everyday gate and network tools use the outward gate.
Native deny and managed rules keep precedence. Owner-authored native custom
rules continue to live in Claude's own settings; category presets do not create
a separate rule store or bypass the harness's security policy.

The Claude and Codex worker bridges also expose `message_clankie_status` for a
returned delivery ID. This reads current delivery progress for the original
sending seat without resending or marking the report read. Check before retrying
or doing dependent work; an unknown status is not proof that nothing was sent.
`clankie agents message-status DELIVERY_ID` provides the same read in your native
pane.

### MCP name and result migration

New sessions register the operator server as `lead` and the worker server as
`worker` (also in Codex). The scoped Claude operator seat displays `clankie` (the plugin alone displays `plugin:clankie:lead`) and
`plugin:clankie-worker:worker`. Existing `clankie` registrations retain their
permission rules and catalog/receipt support until those sessions restart.
Managed new Codex launches disable the old registration to avoid two bridges;
refreshing an existing session writes its original registration's revision.
Owner-managed configuration remains owner-managed.

MCP results put a readable summary in the first text block and decoded data in
`structuredContent`. Read that object, or use `decodeMcpResult` from
`@clankie/protocol/mcp-result` for both current and retained legacy results.
Service HTTP results and receipt journals retain their original format so older
installed CLI publishers keep working; the display projection runs in native bridges. Errors, media and receipt metadata
remain part of the result; an uncertain outcome must be reconciled, never retried.

### Hook module paths

Claude resolves `hooks/hooks.json` module declarations inside the hooks directory.
Both plugins declare `./mods/tool-catalog.mjs`. Edit only
`worker/mods/tool-catalog.mjs`; `node integrations/claude-plugin/build.mjs` copies
it into `hooks/mods/` and `worker/hooks/mods/`, and `--check` rejects stale copies.
Keep declared module paths inside that directory; `../` paths are rejected by
native `/reload-plugins`.
