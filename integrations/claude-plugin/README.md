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
handles the turn in that chat. Goal continuations remain with their service Pi loop.

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
`clankie@inline`, and addresses that identity with the development channel flag.
Claude's [session plugin identity and precedence](https://code.claude.com/docs/en/plugins/loading)
keep the old marketplace skill catalog from leaking into this seat. It starts
with `--name Clankie`. A seat on the global chat names the Herdr pane
`clankie` inside the service's fleet.
`--plugin-dir` chooses the component source; the projection still supplies the
shipped skills. `--dry-run` shows the plugin projection and catalog.

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

In the session, `/mcp` lists the `lead` server, `/clankie:this-machine`
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
`tools/list_changed` handling. Running turns, tools and background agents hold
these probes. Reports keep the exact current session and server namespace;
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
delivery. An owner-enabled worker plugin also serves a hand-started session in
a linked Herdr pane without that flag; its observed synchronous prompt hook
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
in `CLANKIE_RESOURCE_HOLDER`, scoped to a subshell for that command, clearing an
ancestor Codex thread ID. A persistent Bash session cannot retain one child’s
export for a sibling. Worker 0.6.11 gives the hook changes a new cache version;
doctor/native setup also require its Bash resource hook, not just lifecycle hooks.
Existing sessions must use their native hook reload before new definitions apply. They preserve tool fields
and leave permission decisions to Claude. The resource CLIs use it for independent
simulator ownership and named heavy holders; they do not write a shared env file.

Before a checkout worker install or fleet copy, the existing Codex materializer
refreshes both snapshots. Release assembly does the same.
`node integrations/claude-plugin/worker/bin/skill-bundle.mjs` builds them manually.
Each has a separate `skills/NAME.bundle.json` recording its content SHA-256 and
worker version. A standalone package validates both regular snapshots without
importing a repository or builder. An older clankie-only package must be refreshed
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
`worker` (also in Codex). Claude displays `plugin:clankie:lead` and
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
