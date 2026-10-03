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

Running Claude Code as a worker in Clankie's Herdr fleet does not require
replacing the lead with this seat. Linear notifications follow the connected account's inbox into the operator
conversation's bound Claude seat as a wake; with no bound seat, Pi handles
the turn. Goal continuations remain with their service Pi loop.

Like the [herdr plugin](../herdr-plugin/README.md), this carries only what a
plugin can uniquely declare. Everything else lives in the service and the
`clankie` launcher.

## What the plugin carries

| Piece                                                                                                                                                          | File                       | What it does                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Output style `Clankie`                                                                                                                                         | `output-styles/clankie.md` | His identity on top of Claude Code's engineering instructions (`keep-coding-instructions: true`); forced on while enabled. Generated from `instructions.md`. |
| `SessionStart` hook                                                                                                                                            | `hooks/hooks.json`         | `clankie prompt --lane operator --sections persona,reach,fleet,address,model`: the owner persona, reach, address, model card                                 |
| `UserPromptSubmit` hook                                                                                                                                        | `hooks/hooks.json`         | `clankie memory-card --lane operator --hook`: the newest memory card, once per session and again when it changes                                             |
| MCP server `clankie`                                                                                                                                           | `.mcp.json`                | `clankie mcp --lane operator`: his tool bank over stdio, bearer read from the broker, never from a config file                                               |
| Skills `/clankie:this-machine`, `/clankie:trace-clankie`, `/clankie:lead`, `/clankie:work-items`, `/clankie:computer-use-delegation`, `/clankie:research-team` | `skills/`                  | Links to the shipped skills, available from any working directory                                                                                            |

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

`clankie seat` is also supported. Numbered Claude commands load your interactive
`$SHELL` to resolve account aliases and functions.

`clankie seat` needs Claude Code on `PATH` and a TTY. It projects this plugin into
a fresh private directory, linking the same identity, hooks and MCP config with
only skills included by `skills.opinionated` and `skills.exclude`. This supports
arbitrary exclusions as well as a product-only seat without generating a separate
build for every combination. The output-style generator remains the single source
for both settings.

The launcher passes the permission allowlist for `clankie` commands, disables an
older installed `clankie@clankie` for this session, enables the projected
`clankie@inline`, and addresses that identity with the development channel flag.
Claude's [session plugin identity and precedence](https://code.claude.com/docs/en/plugins/loading)
keep the old marketplace skill catalog from leaking into this seat. The session
keeps its MCP tools, hooks and wake channel with either skill setting. It starts
with `--name Clankie`. An explicit `--conversation global-default` names the
Herdr pane `clankie` inside the service's fleet.
`--plugin-dir` chooses the component source while retaining skill filtering.

Use `clankie skills opinionated off` or `/skills` to change the selection.
`--dry-run` shows the plugin projection and catalog; start a fresh session when
changing conditions because resumed history can contain previously loaded skills.

`--conversation ID` resolves an existing global/workspace conversation through
`GET /v1/captain/seat-context`, starts Claude in its service-owned workspace and
binds the prompt, MCP tools and channel to that conversation. The selected
workspace must exist on the native host. `--resume` retains the binding and
refuses a different ID. Without a selection, each fresh launch creates its own
workspace chat through `POST /v1/captain/seat-context`, even when several seats
use the same directory or Claude account. Its transcript, tools and wake channel
belong to that chat. `--resume` reopens the last seat and its chat for the selected
Claude command; `--conversation global-default` explicitly selects the shared
global chat. Workspace seats do not claim the global Herdr head name.
`--dry-run` describes the new conversation without creating it.

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
clankie seat --dry-run                # projected plugin, selected skills, channel: true
```

In the session, `/mcp` lists the `clankie` server, `/clankie:this-machine`
loads his install skill, and `clankie model status` runs without a prompt.

## Worker channel plugin (`clankie-worker`)

[`worker/`](worker/) is a second plugin in the same marketplace,
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

In a herdr pane the server also offers one tool, `message_clankie`: any agent
there, hired or not, can write to Clankie first. He receives it as that agent's
output, never as the owner's instruction, and answers with `message_seat`;
with a live channel the answer arrives immediately. A hand-started session with
an observed worker hook can instead receive the answer as additional context on
its next `UserPromptSubmit`, without `--channels`. Clankie binds held mail to
that native session and terminal, keeps it for at most 24 hours, and hands it
to the hook once. A replacement occupant cannot take the old mail. An uncertain
HTTP or output-pipe handoff is retained as a receipt, never replayed. A successful
hook output acknowledgment means `delivered`, not model consumption.

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
| He answers as Claude Code                  | The seat was not launched by `clankie seat`, which enables the plugin for its session      |
| Every Claude Code session answers as him   | The plugin is enabled at user scope; `claude plugin disable clankie@clankie`               |
| `/mcp` shows `clankie` failed              | The service is down or the operator credential is missing: `clankie status`                |
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
rejection and retries that rejected request once. Concurrent requests share the
new session. Network failures and lost tool results are not replayed because the
tool may already have run. Persisted Herdr watches retain their stable terminal
identity when a wait process fails, retry observation, and resume on service start.
A failed wait is not treated as agent completion.

An already-running bridge must be reloaded once to pick up this implementation:
reconnect the plugin's **operator** MCP server (`clankie mcp --lane operator`),
not only the separate fleet mailbox (`clankie mcp --seat`).

The seat denies every inherited Linear MCP connector (any server on Linear's
host or named for it, in user, local or project scope, plus the claude.ai Linear
connector), whose identity may differ from the owner-connected account. That connected tracker identity is
Clankie’s and his whole swarm’s identity. Tracker writes use Clankie’s connected
tools or a granted worker bridge; a worker lacking access asks the lead to write. Follow Linear wakes the operator conversation
from that account's actual notifications; stored issue bindings do not route wakes.

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
and native Codex worker plugin. `clankie herdr prepare NAME` explicitly installs
and enables the worker for hand-started and hired agents across remote Claude
profiles, including `CLAUDE_CONFIG_DIR` and named `~/.claude-*` directories.
The worker MCP server is `clankie`. Bump both worker manifests on every shipment
so native caches cannot retain an older protocol at the same version.

`clankie doctor [--machine NAME]` compares deployed versions with the service and
reports bridge, hook and `clankie` skill presence separately. Native Codex worker
packaging lives beside the Claude packaging in `.agents/plugins/marketplace.json`
and `worker/.codex-plugin`; it reuses the fleet bridge, has no operator bearer and
does not advertise Claude hooks as Codex receivers. Managed Codex configuration
must go through its real source/setup. Live membership and reply delivery require
native session proof; installation alone supplies neither.
