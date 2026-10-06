# Architecture

Clankie is a persistent agent with a personality, implemented as one service
plus the clients and connections around it. The service owns his built-in pi runtime,
conversations, goals, memory, tools, credentials, and authority. The React Native
app in the private `clankie-app` repository reaches this service; the public
gateway, accounts, and managed provisioning live in private `clankie-ops`.
The service can run on
an owner's machine or a hosted machine. The app and console are clients of
that service; a worker runtime and a work tracker are independent connections.

For a product overview, read [How he works](https://docs.clankie.bot/how-it-works/).
For source setup and the subsystem map, use [Contributing](../CONTRIBUTING.md)
and the [library index](README.md). This document owns the current system shape
and cross-component request flows. Historical diagrams remain in the ADR archive.

```mermaid
flowchart LR
  App["iPhone / iPad app"] <-->|"encrypted device exchanges"| Gateway["Public gateway"]
  App <-->|"optional direct device route"| Service
  Gateway <-->|"authenticated outbound connection"| Service["Clankie's service<br/>pi · conversations · goals · tools"]
  Console["Console / CLI"] --> Service
  Native["Optional native operator seat"] -->|"MCP + transcript bridge"| Service
  Discord["Configured Discord body"] --> Service
  Service --> State["Host-owned state<br/>memory · files · credential broker"]
  Service --> Models["Configured models and services"]
  Service --> Runtime["Execution connections<br/>built-in route: Herdr"]
  Runtime --> Workers["Native interactive worker agents"]
  Service <-->|"harness channels / session APIs"| Workers
  Service <--> Work["Repo tracker or task files"]
  Service --> World["Clankie's own PokeAgents seat"]
  World --> Viewer["Optional game watch surface"]
  Discord --> Vox["One native Vox child<br/>when media is enabled"]
```

Capabilities are configured per host. A managed Linux deployment does not
implicitly provide desktop input, Discord media, or a game world.
The [Linux guide](../infra/hosted/README.md) owns that deployment's capability
set; the [agent-host guide](../packages/agent-hosts/README.md) owns native
worker support. [ADR 0181](adr/0181-clankie-is-independent-of-his-connections.md)
records the separation between Clankie and his connections.

## Customer support authority

The body owns customer-issued support grants, durable revocation and mandatory
audit. An owner operator or paired device with terminal control can create a
referenced Read state or Shell window of at most 72 hours through
[`clankie support`](cli.md). Read-state pairing carries no ordinary device
grants: the relay admits only a closed state/history read allowlist and rechecks
the live window before each disclosure, including streams. Shell windows refuse
pairing; hosted shell enforcement belongs to private `clankie-ops`.

Hosted account tickets bind the exact command, account, tenant, installation,
browser key and nonce. The body durably fences replay before executing and seals
the response. Neither account metadata nor captain authority creates a grant.
Support audit uses keyed device references and a separate durable spool;
disclosure fails closed without it. Independent sink acknowledgements govern
spool pruning, regardless of diagnostic consent. Public/private artifacts and
hosted rollout must be coordinated; source integration alone does not prove
production enforcement.

## Approved commit integration

The source-checkout service owns an approved-commit integration queue through
`POST /v1/integrate` and `clankie integrate`. All core/app main landings use this
queue. Requests waiting during a gate share the next compatible batch;
conflicting requests roll back and failed shared gates split to isolate failures.
Doctor offers a tracked direct-main pre-push guard for source checkouts.
`integrate status` and `/integrate` expose running/waiting work and the last result.
Each batch has independent Git clones and detached sibling worktrees, private gate environments and durable tested-HEAD
records. Exact passed trees land core before app; partial landings preserve each
confirmed SHA. Named deploy holds guard landing and runtime-update admission,
with explicit audited operator overrides. [Integration](integration.md) owns the
contract, isolation boundary and recovery rules.

```mermaid
flowchart LR
  Approvals["Ordered approved SHAs"] --> Queue["Service integration queue"]
  Queue --> Compose["Fresh origin + detached sibling worktrees"]
  Compose --> Gate["Private installs + full checks"]
  Gate -->|pass| Record["Durable exit code + tested HEAD"]
  Gate -->|shared failure| Split["Smaller batches / report failing request"]
  Split --> Compose
  Record --> Verify["Exact HEAD + clean tree + current origin"]
  Verify --> Hold["Deploy holds / audited owner override"]
  Hold --> Core["Fast-forward core"]
  Core --> App["Fast-forward app / retain partial result"]
```

## Device and host authority

The host issues pairing offers and device sessions and decides every grant.
The public gateway carries bounded exchanges to an authenticated host over its
outbound connection. A paired device follows the returned host-scoped route;
its encrypted application payload stays between that device and the host.
Self-hosted Macs can also advertise an explicitly configured direct device
route. One pairing offer carries the available routes; direct pairing does
not require an account, and device grants remain host-enforced
([ADR 0204](adr/0204-a-self-hosted-mac-pairs-the-app-directly.md)).
Optional push delivery has a separate metadata store and authorization contract.
The [network reference](https://docs.clankie.bot/network/) owns the public
host-route table and transport boundary.

On a self-managed Mac, account sign-in enrolls the host at that doorway. On a
managed machine, signed bootstrap and pairing contracts supply the host identity.
The service-side contracts are documented in [credentials](credentials.md) and
[Linux deployment](../infra/hosted/README.md). Account, gateway deployment, and
managed provisioning implementation belong in the private operations repository
([ADR 0183](adr/0183-the-harness-is-public-the-hosted-service-is-private.md)).

The public service also defines optional host-selected
[`runtime-provider` hooks](../apps/clankie/src/runtime-provider.ts), empty by
default. Private managed-body composition supplies quotas, credit routes,
heartbeat accounting and model-plan policy through those hooks. Generic service
lifecycle, transport, signed pairing and device-security recovery stay public.
The [Linux guide](../infra/hosted/README.md#optional-runtime-provider) documents
module selection across launcher restarts.

## How a message becomes a turn

Each surface authenticates a request and selects a conversation. The service
runs or steers the turn, retains its result and exposes replay or live tails.
Discord transport, operator clients and native seats use the paths below;
autonomous continuations re-enter the same conversation queue.

### Discord ingress

The older [message-to-captain JPG](diagrams/clankie-message-turn-sequence.jpg)
is a historical snapshot; the present flow is described below.

A Discord message reaches the active bridge. A text-only message in the live
voice channel's attached chat enters that room's existing `VoiceFloor`; the
realtime room thread may answer aloud, ask Clankie to act, or stay silent,
and no separate text turn races it ([ADR 0124](adr/0124-one-self-has-many-local-threads.md)).
Every other message posts to `POST /v1/captain/channel-turns`. The bridge asks for an immediate
acknowledgment and polls `GET /v1/captain/channel-turns/{deliveryId}` until the turn settles, so a
long model turn does not depend on one open HTTP request. A retry submits the same delivery ID;
the service joins a surviving turn, and the bridge's inbox saves the final reply and permits only
one progress post for that Discord message across restarts. Before dispatch, the service atomically
records the exact ID, request fingerprint and authorized lane in `discord-turn-receipts.json`
under its state directory. Completed results remain deduplicated. An unresolved receipt after restart,
a rejected promise, or unreadable receipts return `uncertain`; neither an HTTP retry nor time passing
starts a replacement turn. Only the original exact turn result settles that receipt. There is no
blanket retry override or automatic reconciliation from another session's transcript. Pending means
`stored`, an explicit native acknowledgment means `consumed` (not model-read), and a completed
channel result reports `responded`; unknown failures stay `uncertain`.

The service normalizes each admitted message — untrusted body
fenced and labelled, images resolved to bytes at the last hop, channel context
attached — and prompts a pi session. Every room gets a continuing session (a pi
JSONL tree that survives restarts): operator conversations, voice channels under
`~/.clankie/captain/voice/`, and text channels under `~/.clankie/captain/rooms/`
([ADR 0118](adr/0118-a-text-room-is-a-durable-lane.md)). A message that arrives
while that room's run is streaming is steered into it and reported `absorbed`,
so a burst of messages gets one merged reply rather than one reply each
([ADR 0091](adr/0091-a-mid-turn-message-steers-the-turn.md)). The channel
backlog still rides in with the request, and is used only when the lane does not
already hold that conversation. A privileged turn drops to a one-shot, which
writes its own tree under `~/.clankie/captain/turns/` so the tools it ran are
readable afterwards ([ADR 0107](adr/0107-a-one-shot-turn-still-leaves-a-trail.md)).
The reply carries the turn's last screenshot or generated image with it — and
when that artifact cannot be resolved, the words still post and say the picture
did not — while replying with the silence sentinel sends nothing: silence is a
real answer. Healthy Pi turns have no total duration cap — looking something
up properly is work, not a fault — but a Discord Pi turn with no executing tool
and no event for five minutes is a dead stream, so the stall watchdog aborts its pi session and
settles it as `captain_turn_stalled`. While someone waits on a slow requested
turn, he can post one short `send_text_update` message to the channel ("hang on,
pulling the bracket up") without ending it; work he elects to do on his own
stays quiet. In channels where the owner enables `/clankie tools mode:on`, the
host also edits one quiet tool-activity card with public-safe work categories,
counts, elapsed time, and a terminal state; tool names, arguments, and results
stay in the local Pi trail ([ADR 0134](adr/0134-discord-tool-work-is-a-status-card.md)).
Discord shows him typing as soon as ingress accepts a live message asked of
him (a DM, a mention, or one of his names), before calling Clankie, and it
stays visible through thinking and tool work. Room chatter he is merely shown
lights only when his reply stream can no longer be the silence sentinel, so a
turn he ends in silence never shows the room a reply being written. Buffered,
dropped, duplicate, and backlog catch-up messages do not start typing.

The self-hosted voice brain is selected through `/voice` or `clankie voice brain`.
OpenAI/xAI realtime and the optional Claude text brain share that same floor and
voice tools. Claude uses the existing per-speaker OpenAI transcription and
ElevenLabs speech wrapper; it receives attributed text, and interruptions abort
its request and retire the mouth's output. Native owner voice-setting changes
persist public settings and require a body restart. Hosted provider selection is
separate; [the manual Sonnet trial](testing/2026-10-06-sonnet-voice/manual-trial.md)
owns live latency and quality proof.

### Operator conversations and fleet views

The TUI and relay speak the same operator-conversation contract
(`/operator/v1/dispatch`): durable agent personas, their current fleet seats,
one coherent cursor-long-polled fleet snapshot,
revision-fenced sends, cursored replay,
and long-polled tails. A tail carries two things: the durable events, and the
message the captain is typing right now — a volatile draft held in memory,
never in the event log, that the settled `message` event replaces in the block
it streamed into ([ADR 0141](adr/0141-the-console-watches-him-type.md)). Herdr
persona conversations are direct-send lanes with no Pi session. The persona
owns its name, full appearance tuple, DM, and channel memberships; its current
Herdr seat supplies live status, terminal routing, and its placement — the
Herdr workspace and tab it sits in, read from `herdr api snapshot` beside the
agent list — so a roster can be laid out the way the owner arranged the work.
Their readable
history folds the complete active user/assistant branch from Herdr's native
Claude Code, Codex, Pi, or Grok session identity; raw terminal bytes stay on the
terminal lane ([ADR 0135](adr/0135-a-herdr-seat-is-a-conversation.md)). The app
and controlled managed-server Discord project those same host-owned records and
logs. Discord faces are app-baked PNGs served under content-hashed HTTPS paths
by the existing Activity origin
([ADR 0147](adr/0147-an-agent-persona-outlives-its-herdr-seat.md)).
Herdr's native event subscription advances the volatile fleet cursor; persona,
seat, channel, and stance changes advance the same cursor. Foreground apps
therefore render one current seats/personas/channels moment without polling or
persisting a second world projection
([ADR 0150](adr/0150-the-fleet-is-a-live-cursor.md)).

### Native operator seats

A fresh Claude, Codex, OpenCode or Grok launch without a selection takes the shared
global head (`global-default`) while no live seat's channel is polling it. If one
is, or with `--new`, the launch creates a separate workspace chat at its launch
directory, with its own transcript, tools and outbox. `--resume` retains the last
seat's binding; `--conversation ID` selects an existing chat. Dry runs create no
conversation.

A seat can also select a canonical Discord room. Its live conversation channel
receives worker reports, escalations, wakes, watches and room turns through the
existing outbox. A shared admission fence keeps a service turn already started
with its runner and pins taken or uncertain native deliveries; only definite
pre-acceptance refusal permits fallback. New inputs use the service runner when
the seat leaves. Room replies retain their original actor, route and mouth lease;
the cached room MCP bank has social authority without generic operator body
access. Worker ownership uses the persisted hire proof and changes when another
conversation admits `message_seat`. Explicit ownership wins. Unadopted reports
use the actual census parent/launcher's current native occupant and attached
conversation or existing native channel. With no eligible parent or a removed
adopted conversation, the default chat receives a tagged fallback reason; the
roster and doctor name the parent pane lacking a bridge. Parent discovery grants
no tools, and missing original room authority remains a refusal. Existing inbound
receipts freeze accepted report IDs across adoption, handover and restart.
Explicit watches retain
their arming conversation. See
[ADR 0218](adr/0218-native-seats-drive-their-attached-conversation.md).

A five-minute service inactivity watchdog starts at reservation and includes
cold preparation, before a Pi session exists. Host-observed preparation progress
and Pi events renew it. The watchdog is suspended while one or more Pi tools
execute; tools retain their own timeout and cancellation behavior. A full
five-minute idle window resumes after the last tool ends. Before execution starts,
or with no active tool and no preparation or streamed progress, inactivity still
times out after five minutes. Healthy work has no total duration cap; queued runs
do not consume the timeout while waiting.
Question authority and hook checks before driver selection, and native attachment
preparation before dispatch, are also bounded. On a stall, the host aborts and evicts the exact
cached startup/session, prevents late completion from prompting or publishing,
and releases admission so
the attached seat can receive later queued inputs. Stored runs fail with
`conversation_turn_stalled`; the service log records the conversation, run ID
and stalled phase. The original acceptance and receipt remain, with no replay
and potentially unknown earlier effects. Native delivery keeps its existing
acknowledgment deadlines and ten-minute escalation reply wait; a timeout never
turns accepted or uncertain native delivery into permission to replay it.

`clankie codex` selects the [Codex plugin](../integrations/codex-plugin/README.md).
Its trusted native hooks add the shared identity, service context and memory card,
and sync redacted transcript entries to the selected conversation. The real Codex
TUI creates a thread on its owned app-server; the launcher reuses the same Codex
seat driver as fleet hires and the existing outbox pump for wakes, watches and
escalations. Hook trust is an owner step in `/hooks`. Until those hooks run, the
launcher does not bind the outbox. Claude remains the default harness.

The operator seat is a place any harness can sit
([ADR 0152](adr/0152-a-harness-takes-the-operator-seat.md)). `clankie claude`
opens Claude Code, on the owner's own plan, as Clankie: the plugin at
[`integrations/claude-plugin`](../integrations/claude-plugin/README.md) forces
his identity as the output style, injects the owner persona, reach, address,
and service model card at session start (`clankie prompt`) and the newest
memory card once per session and then only its new notes (`clankie memory-card --hook`), and names one stdio MCP
server, `clankie mcp`, that bridges to the service's lane tool bank at
`/v1/mcp` with the operator bearer read from the broker. The bank is the same
authored registry the pi session is built from, wrapped once at runtime and
scoped by the bearer's lane, so a Codex pane with the same entry is the same
seat. A connected service lists only its `initialTools`; the rest of its catalog
is reached through `mcp_tool_search` and `mcp_tool_call`, so a harness does not
carry every tracker schema on each request. All lane and fleet wire catalogs are
checked by `pnpm mcp:check` in the fast push/PR gate, using Claude Code's strict
MCP SDK contract and Codex's input-schema conversion shape. Failures identify
the tool and field. Connected catalogs validate each tool before admission;
`mcp.host.tool_rejected` records the provider, tool and reason, leaving healthy
tools available even when a provider returns one incompatible entry.
Native catalog health is a separate session-bound observation: Claude's trusted
plugin mod reads its accepted tools; managed Codex reads the original thread's
native MCP status. The service compares that list to the bridge expectations
and projects `toolCatalog` into the roster and `toolCatalogHealth` into doctor.
A live process never substitutes for this evidence. Embedded hand-started Codex
has no introspection endpoint and stays explicitly unverified with the managed
hire action; its native introspection remains future work. Per-turn hook commands
(`memory-card`, `seat-sync`, `seat-hook`) skip the launcher's import graph. A herdr pane named `clankie` is his head: the census binds it to his own
persona rather than a fleet contact and projects its transcript into the
conversation the app pins. While a seat is bound, self-wakes, herdr completion
watches, and room escalations reach it as channel events pushed by `clankie
mcp`; with no seat open they run the service conversation on pi. A native seat
attached to a Discord room receives admitted turns with their original room
authority, as described above; attachment does not grant operator tools. Every
fleet seat has a mailbox of its own, and a Claude Code seat launched with the
channel runs `clankie mcp --seat`, a channel-only bridge that polls it: a DM or
room turn then lands as a channel event instead of keystrokes typed into the
pane's pty. Local briefed Codex hires use a dedicated app-server: the native TUI
creates the session, `turn/start` and `turn/steer` deliver messages, and
`turn/completed` supplies completion. A native Codex TUI in Herdr connects to
that same server and thread for viewing and owner takeover. The app-server runs
outside Clankie's service process group so a service restart does not disconnect
or stop the native worker. The adapter reports
the thread ID explicitly, so the fleet census does not depend on shared-daemon
hooks. Existing unmanaged Codex seats can use their native `codex queue` when
available. Automated messages never fall back to typing in the terminal. Missing
control, waiting consent, and uncertain delivery remain explicit outcomes. A
`turn/steer` receipt reports guidance to the active turn, not an after-turn queue
([ADR 0207](adr/0207-work-records-and-native-agent-delivery.md)).

### Conversation selection and retention

A TUI process opens the existing main Clankie conversation unless `--chat`
selects another. `/new` creates a fresh conversation explicitly. A captain conversation and its Pi session are one lifetime: bounded
retention removes their shared directory, while public event logs rotate with
typed cursor recovery ([ADR 0111](adr/0111-a-console-process-starts-one-conversation.md)).
`/btw` temporarily selects an ephemeral child made with Pi's native current-leaf
fork, opening it on a clean screen at that boundary. A hidden boundary makes the
inherited branch reference-only; Ctrl+X swaps between the child and its parent
without discarding either, and Ctrl+C cancels and deletes the child, restores
the parent transcript, and replays any parent events that arrived meanwhile
([ADR 0143](adr/0143-btw-is-an-ephemeral-pi-fork.md)).
Discord text and voice captain rooms also appear in the operator conversation
registry under `room` scopes. Their native Pi trees remain in `rooms/`, `voice/`,
and `turns/`; the existing native-transcript projection folds context, messages,
and tools into the same replay/tail API used by the TUI and CLI. One room groups
its social, trusted, and one-shot session histories without merging their model
contexts or authority. Source checkpoints prevent duplicate replay after restart.
Ordinary operator sends and resets remain read-only for these records. An
attached native seat can execute admitted room turns and return correlated replies
through the existing Discord transport. See
[ADR 0176](adr/0176-every-room-is-an-inspectable-conversation.md).

Every admitted room handoff has a separate durable child conversation, visible
under Clankie in the TUI dock and app with who asked, current work and result.
A shared queue admits four voice and text requests globally, at most two per
room, and holds at most 32 waiting jobs; excess requests receive a busy result.
The canonical room retains authority and the reply destination. A service head
runs separate Pi threads; a Claude head starts restricted native children; a
Codex head starts native children only for the verified owner and uses Pi under
the original room lane and grant for every other speaker. Actual native ancestry establishes
child references, and taken or uncertain native requests are never replayed as
Pi work. See [ADR 0229](adr/0229-room-handoffs-are-visible-parallel-threads.md).

Conversations are files under `~/.clankie/captain/`. Each settled operator or
Discord captain turn also appends one metrics line to
`~/.clankie/captain/turn-settled.jsonl`: tool-name counts, first mutating tool,
context-token occupancy, the model/provider/effort that actually executed the
turn, and the provider-reported `totalTokens` summed over the turn with the
number of reports that contributed. Execution identity is read off the live pi
session as the turn executes, so a `/model` or `/effort` change under a live
conversation lands on the next turn to execute rather than being reconstructed
from a settings snapshot afterwards. Unknown is said out loud: a row from before
the capture, or a provider that reported nothing, reads back as `null` — never
zero, and context occupancy is never treated as usage or a charge.
`GET /v1/captain/turn-metrics` and `clankie metrics` return the same bounded
rows, newest first. The file sits beside `autonomy.json`, outside the
conversation directory the retention pass deletes. It is not `~/.clankie/events.jsonl` —
that log already uses `captain.turn.settled` for presence idle/waiting_user, and
the captain does not write domain events. An absorbed steer
([ADR 0091](adr/0091-a-mid-turn-message-steers-the-turn.md)) shares the owning
run's line. The full HTTP
surface is listed in [`apps/clankie/openapi.yaml`](../apps/clankie/openapi.yaml);
[`apps/clankie/scripts/setup-yaak.py`](../apps/clankie/scripts/setup-yaak.py)
imports that canonical catalog into Yaak and adds a Keychain-backed `Local`
environment for authenticated requests.

### Goals and autonomous continuation

The service also keeps `autonomy.json`: one proposed or owner-approved goal and one
replaceable self-wake per operator conversation, plus a global enable switch.
An unreadable file fails closed and surfaces `state_unreadable` to operator
clients instead of silently re-enabling autonomous work.
An active goal in a Pi-owned conversation queues host-authored continuation turns through the same
conversation chain as operator messages, so every tool call and reply stays in
the existing Pi session and public event log. A human message that arrives
while that run is streaming steers it by default; in-flight tool calls still
finish. Explicit `delivery: "steer"` also joins a human-started Pi turn, while
`delivery: "queue"` waits for a separate turn on the conversation FIFO
([ADR 0091](adr/0091-a-mid-turn-message-steers-the-turn.md)). A
finite token budget (default 1,000,000) moves a goal to `budget_limited` before
another provider request; failed turns retain recorded usage. Model calls persist
inactive proposals, confirmed only by `/goal accept`. Native harness seats refuse
service goals, and a queued goal pauses on discovering a native head.
`/goal` owns activation, pause/resume, and clearing, while `/autonomy off` stops new continuations and
wakes. A due wake queues one turn with Clankie's recorded reason and may be
replaced by another. Neither path changes the conversation's tool set or
authority ([ADR 0130](adr/0130-goals-and-self-wakes-share-the-operator-thread.md)).
Each conversation also keeps an append-only goal decision journal under
`~/.clankie/captain/goal-journal/` — one line per real choice made while
working a goal, written through `note_goal_decision` and returned by
`get_goal` so a continuation resumes from what was already decided
([ADR 0132](adr/0132-a-goal-keeps-a-decision-journal.md)).

### Independent evaluation

The optional independent evaluator captures settled Pi turns and native Herdr
reply projections under `~/.clankie/captain/evaluator/`. Its durable queue dispatches
one Codex or Claude Code assessment at a time in a separate Herdr pane; structured
reports retain outcome, efficiency, tool and harness judgments plus issue/MR
links. Goal identity groups continuations, while conversation checkpoints leave
task boundaries to the evaluator. Evaluator descendants are excluded from capture.
`clankie evaluator` and `/evaluator` expose the operator API controls. Linear
following remains independent. See [ADR 0178](adr/0178-the-evaluator-has-its-own-seat.md)
for scheduling, restart recovery and evidence limits.

Exact Discord speech is available through a bounded captain read that returns
content only while owner-controlled transcript retention is enabled. The TUI
and `clankie discord transcripts` use this shared transcript store.

Operator input can invoke an exact loaded skill as `/name task` or
`/skill:name task`. The service rewrites that verified invocation to Pi's native
skill command and enables expansion for that prompt only. Discord input and
ordinary operator prompts keep expansion disabled.

Before each Pi run, a hidden host extension reads a bounded memory
card into the system prompt. The host supplies the destination lane, filters
operator-private notes out of ambient lanes, and refreshes recall without
persisting duplicate cards in the conversation. Discord turns also receive the
newest visible person facts for their authenticated guild/user identity. The
selected notes persist until forgotten. The `memory` tool writes, searches,
edits, and forgets them within the admitted conversation's authority. Notes
and per-person fact files live under
`~/.clankie/memory/`; the TUI's `/memory` command browses, edits, and forgets
that same store through operator-only routes. [`docs/memory.md`](memory.md) is
the full picture — what each store holds, who may read it, and what bounds it.

A second hidden extension appends the model card: the name, ref, and provider he
is actually running on, his reasoning effort, and his context and output limits.
It resolves the same selection Pi executes, on every run rather than once per
session, because `/model` and `/effort` swap the model under a live conversation.
Asked what he runs on, he answers from the prompt like he answers with his own
address — no tool call, no guess, and silence if the selection cannot be resolved.

## Where things run

- **Machine tools.** Coding tools (read/bash/edit/write) are pi built-ins. They
  attach to the operator console and to Discord turns authorized by the
  machine-control grants
  ([ADR 0095](adr/0095-discord-system-actors.md),
  [ADR 0105](adr/0105-voice-is-as-capable-as-the-room-it-is-in.md),
  [ADR 0133](adr/0133-a-machine-grant-belongs-to-a-discord-lane.md)). An
  individually granted actor gets a one-shot tool-bearing turn in shared rooms
  and a durable tool-bearing lane in an official-bot DM. Explicitly trusted
  guilds, optionally narrowed to channels, give every admitted member the same
  durable tool-bearing lane. Social and system histories have separate session
  keys, so revocation routes the next message away from the old tool bank. They
  land in the conversation's workspace — the directory a workspace-scoped
  operator conversation names, this repository for every other lane
  ([ADR 0104](adr/0104-clankie-works-where-you-launched-him.md)). Voice join/leave
  are the same argument-free tools on Discord and the operator console: a
  Discord turn follows the authenticated speaker, an operator turn follows the
  configured owner ([ADR 0062](adr/0062-voice-join-by-asking.md)). The
  canonical authored-tool registry is
  [`apps/clankie/src/captain/tools.ts`](../apps/clankie/src/captain/tools.ts),
  connected-service additions live in
  [`captain/connect-tools.ts`](../apps/clankie/src/captain/connect-tools.ts), and
  the HTTP surface is
  [`apps/clankie/openapi.yaml`](../apps/clankie/openapi.yaml). This document does
  not duplicate their changing census.
- **Browser catalog.** The service owns a Browser Use Pi SDK session. Clankie
  drives its persistent JavaScript workspace directly through `execute()`;
  it does not run a second model or a hidden browser agent. Machine-authorized
  turns receive `browser_use_javascript`; social turns receive browser-only
  navigation, DOM evaluation, accessibility, input and screenshot tools.
  The host enforces the same boundary behind tool discovery and the HTTP API.
  Browser calls are sequential across rooms.
  Model-facing JSON previews retain up to 50 KiB or 2,000 serialized lines,
  followed by a truncation notice when needed. A large page string keeps a
  UTF-8-safe prefix instead of being dropped as an oversized line; full results
  remain in the Pi tool details.
  The SDK's JavaScript worker receives no Clankie credentials, but true filesystem/network
  isolation requires a VM or remote broker ([ADR 0082](adr/0082-clankie-holds-the-browser.md)).
  The persistent profile holds his own accounts, signed up for by hand: the
  `browser_use_open` tool's `headed` argument relaunches Chrome visible on the operator's
  screen, so he can hand over the window for a signup, a CAPTCHA, or a phone
  check rather than grinding at it ([ADR 0127](adr/0127-his-accounts-are-his.md)).
  Browsing defaults to headless. After 60 seconds without a browser call, the
  host saves any recording and closes the burst's tabs/windows, including a
  takeover window. Persistent logins remain; the next burst starts headless.
  The SDK launches Chrome lazily with that private profile and owns its shutdown.
  JavaScript bindings reset at idle close, mode changes or worker timeout; workspace
  files and persistent logins survive. Opt-in recordings sample the current tab
  every 750 ms through the SDK's public CDP primitives and encode WebM with FFmpeg.
  Hard work in the owner's own apps and Chrome goes to a hired computer-use
  harness where one is ready; the service detects them and the reach card
  lists them on machine-access lanes
  ([ADR 0199](adr/0199-hard-computer-work-goes-to-a-computer-use-harness.md)).
- **Leading agents.** Native local hires use `hire_agent`, `message_seat`, and
  `herdr_watch` through [harness adapters](../packages/agent-hosts/README.md#tool-flow-and-current-support).
  Claude, Codex, Pi, OpenCode, and Grok Build have local adapters; Prime Agent
  remains researched. The adapter guide owns platform, version, consent, and
  restart-recovery limits. Skills explain tool use while delivery code enforces
  the no-terminal-fallback boundary. Remote agents use the per-fleet link
  and native harness delivery.
  Herdr supplies the native terminals and process control. The service's
  selected runtime supplies every console's fleet view. Current binding and
  fallback behavior live in [the CLI reference](cli.md#herdr-statusopencreate--herdr-use-name).
  Native Herdr events wake fleet readers across workspaces
  ([ADR 0150](adr/0150-the-fleet-is-a-live-cursor.md)); the optional herdr-lead
  board is a view, not a second coordination authority.
- **His body.** `runFreePlay` drives one seam, `GbaDriverIo`
  ([`packages/play`](../packages/play/README.md)); its mind, voice, progress,
  learned transitions, and behavior loop hold no emulator and never learn what
  implements the seam. One body implements it: Clankie's separately
  credentialed seat in a PokeAgents world, reached through `WorldPlayerClient`
  on `@pokeagents/world-protocol/ipc` (`WORLD_ADDRESS` unix, tcp, or tls —
  defaulting to the world's own socket under `WORLD_STATE_DIR`) and entered
  with the `pokeagent_join_mmo` tool
  ([ADR 0103](adr/0103-a-hosted-world-is-another-body.md),
  [ADR 0145](adr/0145-the-world-is-the-only-body.md)). Clankie is the
  parent of that sitting; `@clankie/play` is the driver — the same split other
  harnesses get from an MCP Task, a subagent, or a CLI loop. That seam consumes
  verified FireRed adapter-v2 and Emerald adapter-v2 payloads, selected by the
  observation's `(gameId, adapterVersion)` pair; unknown pairs and
  game-specific extras the selected schema does not verify fail closed. A
  hosted world cannot be paused, changes without him acting, and can replace
  his body under him, so the loop offers no save, load, or restart action —
  the world persists its own cartridge. `pokeagentMmoEnabled` is the owner
  setting; with it off, or with no world reachable, the ask refuses out loud
  rather than falling back. Frames flow to the Discord activity surface.
  Every sitting carries a stable journey identity separate from its run id, the
  bounded story spans that journey, and the next sitting receives the last
  self-authored notes and objective while exact world state stays with the
  cartridge save
  ([ADR 0126](adr/0126-game-state-history-and-memory-have-separate-owners.md)).
  The journal records body provenance at each causal stage, and its `venue`
  still reads both values because journals written before ADR 0145 are on disk.
  Other harnesses reach the same world through PokeAgents' own front doors —
  `@pokeagents/world-mcp`, its CLI, or the `pokeagent-mmo` skill — each on its
  own credentialed seat, as the same parent-plus-driver sitting (MCP Task,
  host subagent, or CLI loop; PokeAgents ADR 0023), with no control over
  Clankie, Activity publication, play voice, or room input.
  PokeAgents owns player leases and action/session fencing. Clankie's play
  package retains typed body-action refusals beside its driver interface;
  the retired local environment lifecycle engine has no role in hosted play.
- **Spider-Man (disabled bridge).** The integration is not currently available
  for live play; [setup](rivals.md) records the re-enablement requirements.
  Its interface delegates tactical decisions and the guarded real-time
  pad loop to Rivals Agent. Clankie's `rivals` tool and operator API manage bounded sittings,
  objectives, fresh observations, and read-only sharing; the existing Go Live
  PNG publisher carries its video. The Pokémon seam remains unchanged in scope.
  See [ADR 0175](adr/0175-rivals-agent-is-a-gameplay-skill.md) and [setup](rivals.md).
- **Game extensions.** [ADR 0234](adr/0234-games-share-one-extension-contract.md)
  defines typed connector, skill, settings, Activity and lifecycle composition.
  `integrations/pokemon` implements it; core retains play leases, authority and
  recovery, persona/model selection, Discord/Activity destinations and evidence
  projections. Pokémon's existing API/CLI/TUI enter that extension through a
  compatibility composition point. Minecraft and Rivals adoption, and
  installed-extension discovery without core edits, remain follow-ups.
- **PokeAgents boundary.** The sibling PokeAgents repository owns the
  `WORLD_OPERATIONS` catalog, capability schemas, native client transport, and
  the MCP projection derived from that catalog. MCP carries calls; the world
  contract and host enforce player identity, authority, and gameplay semantics.
  Clankie currently imports only the pinned `@pokeagents/world-protocol`
  package (including `/ipc`) and keeps host, emulator, persistence, and
  world-MCP packages out of product source. Hosted play composes
  `WorldPlayerClient`. Every catalog operation is classified body or mind;
  unclassified names stay off `pokeagent_world` until classified. The play loop
  owns BODY (`world.join`, `world.leave`, `play.observe`, `play.act`,
  `play.frame`, `play.watch`); the mind owns session, who, regions, travel, and
  challenges. Pokémon usage caps, failure backoff, bounded voice preemption and
  pre-action state rechecks live above this body seam in `packages/play`.
  The service sends each notable kind once to the original conversation under
  its existing grant, including terminal events after the initiating turn ends.
  `pokeagent_guide` offers context to that conversation's play mind; it never
  forces an action or replaces the mind's choice. See [play](../packages/play/README.md).
- **Auth.** Provider keys and OAuth tokens live in the credential broker
  (Keychain), written by the TUI `/auth` flow and read by pi through a
  credential-store bridge. Compatibility model/media provider keys may fall
  back to existing shell values or the gitignored root `.env.local` when the
  broker has no entry; Discord account and body credentials remain broker-only
  except documented operator/captain test overrides. Persona is owner-authored in
  `~/.config/clankie/settings.json`; the authenticated owner surfaces and CLI
  can update it. Untrusted messages and model output cannot override that identity.
  `/connect` stores Linear and mailbox credentials the same way; Discord
  remains a body configured by `/discord` ([credential guide](credentials.md),
  [ADR 0093](adr/0093-owner-authored-service-connections.md)). The mailbox is
  his own address, not the owner's inbox: `email.fromAddress` carries the
  identity when the provider login differs, Clankie states that address
  from settings, and mail stays console-only because sign-in codes arrive there
  ([ADR 0127](adr/0127-his-accounts-are-his.md)). That address is public, so every
  message the mail tools return is labelled untrusted sender text the way a
  Discord body is ([ADR 0081](adr/0081-an-image-is-part-of-what-is-said.md)). A seat in a
  hosted world is a broker credential too — `pokeagent_mmo_world`, with the
  environment variant refused outright. Each media-enabled active Discord body
  owns one `clankvox` child through the Apache `@clankie/vox-client` boundary.
  A text-only official-bot process does not spawn Vox. Both media-enabled bodies
  use its primary role for voice, TTS, and music; the lab user body can
  concurrently watch screen shares and publish Go Live through separate roles
  ([Discord media guide](discord-media.md),
  [ADR 0128](adr/0128-vox-is-the-sole-discord-media-owner.md)).
  `/discord` Active body picks which process is the mouth; the launcher
  starts only that one ([ADR 0048](adr/0048-discord-user-session-transport.md)).
  Who may ask him to drive this machine from Discord is configured under
  `discord.systemActorUserIds`, `systemActorGuildIds`, and
  `systemActorChannelIds`
  ([ADR 0133](adr/0133-a-machine-grant-belongs-to-a-discord-lane.md)).

## Shared bodies and present state

Parallel conversations belong to one Clankie and arbitrate the shared
`discord_mouth`, `voice`, `browser`, `computer`, and `play` resources through
[body leases](../apps/clankie/src/body-leases.ts). Conversation identity and
incarnation tokens fence stale operations; viewing a resource does not acquire
it, and a lease never adds authority. Uncertain operations require explicit
recovery rather than age-based takeover. The
[router](../apps/clankie/src/body-lease-router.ts) preserves the original machine
or social route when handing a request to the holder. See
[ADR 0215](adr/0215-conversations-lease-one-body.md) and the
[CLI reference](cli.md) for ownership and recovery operations.

The Pokémon body remains a PokeAgents seat. Minecraft has a separate
service-owned MCP motor under the same `play` resource: the existing service
session decides its actions, while Mineflayer handles movement and physics.
The offline body slice is implemented; online account authentication and live
multiplayer/Discord acceptance remain deferred. Its current scope and setup live
in [Minecraft](minecraft.md) and
[ADR 0219](adr/0219-minecraft-is-an-mcp-connected-body.md).

The operator `presence` operation projects current thinking, voice, play, active
seats, and pending owner work from their existing sources. It does not persist
another mood state. The `desktop` tool publishes a bounded transient expression;
publication does not prove a client displayed it. Quiet hours and expiry apply.
The projection and expression ownership live in
[presence.ts](../apps/clankie/src/captain/presence.ts) and
[desktop.ts](../apps/clankie/src/captain/desktop.ts), following
[ADR 0220](adr/0220-clankie-has-one-present-tense.md). The desktop pet consumer
belongs to the private app.

## Native media plane

Each media-enabled active bot or user-session body owns exactly one `clankvox`
child. A text-only official-bot process owns none. Apache product code speaks
through `@clankie/vox-client`; the AGPL executable owns DAVE, RTP/RTCP, codecs,
capture, TTS/music pacing, screen-watch, and Go Live publishing. The TypeScript
`DiscordVoiceSession` retains consent, attribution, floor, realtime-provider,
and captain-handoff policy.

Readiness is role-specific: versioned `process_ready` must exactly match the
client IPC protocol and proves only that the child can serve IPC;
`transport_state=ready` proves a role's Discord media transport; and positive
`dave_state=ready` proves that role's negotiated DAVE session. Primary voice
ready, connection, transport, DAVE, and error events are correlated by the
caller's `connectionId`. The detailed current diagram and evidence rules live in
[ADR 0128](adr/0128-vox-is-the-sole-discord-media-owner.md).

## Reading the source by domain

Existing entry paths retain their public exports. These modules organize the
implementation behind those entry points; callers continue to import the same
paths.

| Entry point                                                             | Domain modules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Protocol](../packages/protocol/src/index.ts)                           | [Operator conversations](../packages/protocol/src/operator-conversations.ts), [fleet messages](../packages/protocol/src/fleet-messages.ts), [terminal transport](../packages/protocol/src/operator-terminal.ts), [Discord presence](../packages/protocol/src/discord-presence.ts), [voice evidence](../packages/protocol/src/discord-voice-evidence.ts), [embodiment](../packages/protocol/src/embodiment.ts), and the other named wire-contract modules beside the barrel. The package has no other workspace dependencies.                                                                                                                                                                                                                                                                                           |
| [HTTP app](../apps/clankie/src/app.ts)                                  | [Runtime composition](../apps/clankie/src/app/runtime.ts), [seat delivery](../apps/clankie/src/app/seat-routes.ts), [Discord routing](../apps/clankie/src/app/discord-routes.ts), [voice briefing route and renderers](../apps/clankie/src/app/voice-briefing.ts), [memory](../apps/clankie/src/app/memory-routes.ts), [pairing](../apps/clankie/src/app/pairing-routes.ts), [operator conversations](../apps/clankie/src/app/conversation-routes.ts), and [signed Linear webhooks](../apps/clankie/src/app/linear-routes.ts). Route factories take explicit typed dependencies and preserve registration order.                                                                                                                                                                                                       |
| [Conversation store](../apps/clankie/src/captain/conversations.ts)      | [Store and lifecycle](../apps/clankie/src/captain/conversations/store.ts), [ordinary-chat Linear wakes](../apps/clankie/src/captain/conversations/linear-wakes.ts), [worker reports](../apps/clankie/src/captain/conversations/worker-reports.ts), [native seats](../apps/clankie/src/captain/conversations/native-seats.ts), [transcripts](../apps/clankie/src/captain/conversations/transcripts.ts), [channel projection](../apps/clankie/src/captain/conversations/channel-projection.ts), and [questions](../apps/clankie/src/captain/conversations/questions.ts). Extracted functions receive the typed store explicitly; class methods retain their public signatures.                                                                                                                                           |
| [Runtime orchestration](../apps/clankie/src/captain/captain.ts)         | [Discord turns](../apps/clankie/src/captain/captain-discord-turns.ts), [operator service and fleet roster](../apps/clankie/src/captain/captain-operator-service.ts), [conversation runner](../apps/clankie/src/captain/captain-conversation-runner.ts), [worker report recovery and delivery](../apps/clankie/src/captain/captain-worker-reports.ts), [goal budgets](../apps/clankie/src/captain/captain-goals.ts), [session helpers](../apps/clankie/src/captain/captain-session.ts), [prompts](../apps/clankie/src/captain/captain-prompts.ts), [models](../apps/clankie/src/captain/captain-model.ts), [drafts](../apps/clankie/src/captain/captain-draft.ts), and [operator formatting](../apps/clankie/src/captain/captain-operator-format.ts). Factories preserve live bindings through typed context accessors. |
| [Voice session](../packages/discord-presence-core/src/voice-session.ts) | Consent, attribution, instruction/briefing application, turn-taking, tools, and playback remain together here pending the voice fixes. The [voice floor](../packages/discord-presence-core/src/voice-floor.ts) owns floor arbitration; Vox owns native media transport.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

Fleet members reach verified connected accounts through the service's
`clankie_tools` discovery and `clankie_call` invocation bridge. Fleet membership
supplies that connection authority, controlled by `fleet.tools`; project roles,
caps, hiring, tracker binding, and worker report ownership remain separate.
[ADR 0217](adr/0217-fleet-membership-gets-connected-tools.md) records the connected
tool boundary; [ADR 0207](adr/0207-work-records-and-native-agent-delivery.md) and
[ADR 0218](adr/0218-native-seats-drive-their-attached-conversation.md) record native
delivery and report routing.

## Current architecture constraints

Clankie uses pi's `ModelRuntime` and `createAgentSession` for Clankie's
models, sessions, tools, skills, and compaction. The agent runtime, HTTP surface, and
play host share one service
([ADR 0101](adr/0101-pi-owns-the-captain-model-runtime.md)).
The repo's tracker or task files hold work and results. The service exposes one
Linear-shaped tracker tool surface to Clankie and workers, using the connected
owner account or durable local storage when disconnected; repository conventions
adapt GitHub and Markdown to that same surface. `clankie doctor` reports backend
selection and reason ([ADR 0226](adr/0226-one-tracker-tool-surface.md)).
Account Connections in the app and account page use body-owned GitHub device
authorization and registered Linear S256 PKCE. Provider tokens stay in the
body's broker; the portals exchange only sealed lifecycle requests and public
connection metadata. Registered Linear API OAuth uses a separate `linear-api`
credential and in-process tracker, preserving the existing MCP audience and
grant fences ([ADR 0232](adr/0232-hosted-connections-use-the-body-broker.md)).
Both Linear audiences share a service-owned [request budget](../apps/clankie/src/linear-request-budget.ts)
per verified workspace and actor. Actual HTTP attempts are counted over a rolling
hour, provider rate-limit headers tighten headroom, and background reads slow
at 80%. Device Work refreshes and explicit CLI/fleet poll markers select background
priority; owner/lead reads, writes and webhook context remain interactive. One
logical read retains admission across provider pagination while every HTTP attempt
obeys the hard cap. `clankie linear budget` and `/doctor` expose
the observation; the 50% warning uses native alerts without starting a model turn.
Herdr contains the native
interactive workers; Clankie uses their supported channels or session APIs for
delivery. Linked independent agents can write first with `message_clankie`. Untrusted input stays fenced, secrets stay in the credential
broker, and every report describes observed outcomes rather than intentions.

[`adr/`](adr/) records the active decisions for play mechanics, voice, presence,
media, browsing, and operator control.

## Distribution

The macOS Apple silicon release preserves these process boundaries inside one
self-contained, versioned directory. A native `clankie` launcher starts the
bundled TUI and Node runtime; the supervisor starts compiled service entrypoints
instead of pnpm workspace scripts. Runtime state and credentials remain outside
the immutable release. [ADR 0136](adr/0136-a-release-is-one-command-and-one-runtime.md)
records the decision, and [`distribution.md`](distribution.md) documents the
artifact and installer. Product skills and `clankie doctor` travel with the
release so he can describe and set up this machine without a git tree
([ADR 0142](adr/0142-the-install-tells-him-the-truth.md)).

## Canonical Homes

The [documentation library](README.md) maps each concern to its owning reference.
Command syntax belongs in [CLI](cli.md), HTTP operations in
[OpenAPI](../apps/clankie/openapi.yaml), and subsystem implementation in the
owning package. This architecture document links to those contracts rather
than keeping a second catalog.

## Hosted Mac console

The launcher resolves local/hosted mode before starting services. Hosted mode
pairs a revocable operator device through account sign-in and carries requests
inside the existing encrypted device envelope. No local body or operator bearer
is started or exported. See the [ADR 0173 amendment](adr/0173-the-gateway-cannot-read-device-traffic.md#amendment-the-mac-can-be-a-hosted-operator-device-2026-09-27-vuh-1110)
for authority and the [CLI contract](cli.md#local-and-hosted-connection-modes)
for supported commands and recovery. Fleet ticket issuance stays private.
