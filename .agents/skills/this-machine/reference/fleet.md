# Fleet, hires and agent history

Owner working preferences, accounts, naming and roles, uncertain hires, native worker control (Codex, Claude, Pi, OpenCode, Grok, Prime Agent), where workers run, closure policy, cross-device conversations, peer messages, worker MCP servers and agent history. Hire choice, placement, report routing, receipts and closing panes are in `lead`'s [fleet tools](../../lead/reference/fleet-tools.md); bridges and connected tools are in [worker bridges](worker-bridges.md).

## Owner working preferences

Read `clankie fleet status` or `clankie doctor --json` in the workspace before work.
They expose resolved global/project commit, push and official-release policy
from the same `autonomy.fleet` settings as closure and machine setup. Unknown or ambiguous project context is reported, not guessed.
Global defaults allow commit/push without asking, ask before official releases,
and preserve explicit task verification and reporting requirements. The existing
registered `clankie` project receives its weekly-release override on migration;
an explicitly cleared override stays cleared after settings are saved.

Every hire receives the resolved project preferences through its native brief,
and Clankie's "Your fleet" prompt refreshes them each turn. Agents opened
independently read the same context through the CLI. Explicit task and integrator
gates take precedence. Preferences do not add credentials, grants, account access
or permission to run evals.

Use `clankie fleet set` for global changes and `clankie project settings PROJECT`
for one project's overrides. `inherit` removes only the selected project leaf.
Release mode and its owner-authored time rule form one atomic preference; a rule
is guidance to verify against current evidence, not scheduled execution. The app
offers the same controls and hides the new ones on older servers without the
`workingPreferences:true` capability. Never edit settings JSON directly.

Local `hire_agent` can use `skills: "plain"` or
`"bundled"` for a single hire; its result records the condition. Global/project
skills discovered independently by a harness are outside Clankie's bundle switch.

Extra Codex accounts are registered homes: `clankie accounts codex add HOME
--label LABEL`, `list`, and `remove LABEL` (also `/accounts codex` in the TUI).
The owner signs in and trusts hooks in that home; never copy credentials or
approve hook trust for them. Hires rank accounts from `worker_accounts`
`allocation` (see `lead`'s hiring reference); missing or stale usage is unknown,
not an empty plan. `hire_agent` can pin `account: "LABEL"`; the hire and roster
report the chosen account. Registration changes apply to new hires only.
Account list/API reads expose native `hookTrust` (`ready`, `review_required`,
`unknown`) for home hooks; repository trust still belongs to the owner.
A home whose sign-in Codex refuses when asked for usage is skipped automatically
and refused when named. `clankie accounts hold codex LABEL [--machine ID]
[--reason TEXT]` keeps an account out of automatic choice (`release` returns
it). Fresh work hires cannot bypass a hold by naming that account.
A hired Codex startup waiting on trust retains its pane and server and continues
the original brief automatically after owner review. A visible hook/folder prompt
reports `trust_required`; other pending startup reports `start_unconfirmed`.
Inspect that pane; do not retry the hire or approve trust yourself. Closing the
pane cancels pending startup.

A private Codex hire that refuses before the turn RPC reports
`briefDelivery: "not_sent"` and `deliveryStage: "unavailable"`. Its native
view and launch receipt remain retained. Inspect the original pane and choose
recovery; retrying the same hire never resends that brief or launches another
worker. A lost native turn acknowledgment remains uncertain. Catalog reads
must name the original thread and its pinned `worker` server; an unfiltered
status read creates discovery runtimes and cannot prove the loaded catalog.

## Names and roles

Rename a hire with `clankie agents rename NAME|PERSONA_ID "NEW NAME"`; this
preserves native identity, appearance and project assignment. `update_persona`
preserves omitted fields from the current saved persona: send only `name` for a
rename, and omit `name` when saving appearance or an avatar. Background image
work must not resend a cached display name.

`clankie agents role NAME "ROLE"|none [--project PROJECT]` changes a current
member's saved station role in that project; omission selects `default`. The host
checks the exact native seat and original hire assignment or verified workspace
membership for agents Clankie did not start, refusing offline, unknown or
other-project agents. It does not change the live harness's launch profile.
With one positional role, `clankie agents role ROLE --project PROJECT [profile
flags]` edits the project's hire profile; `clankie fleet status` shows effective
profiles and `/agents roles` edits them through the revision-bearing owner API.
These preferences affect new hires, not live seats. Prefer a role already in use
(`clankie agents roles`) over a near-duplicate.

Fleet seats you hired or opened report native Claude, Codex and registered local
OpenCode worker subagents as `subagents`; absent means unknown (ADR 0208).
Entries can carry a stable native `id` and `startedAt`/`endedAt`; running
children omit `endedAt`, and Codex idle endings are estimates. Remote and
unaddressed seats remain unknown. OpenCode reads stop at 500 parent messages,
2,000 parts, 4 MiB and 64 task calls; file idleness does not settle an OpenCode task.
`close_seat` asks an owned live worker's original TUI to exit and reports success
after its terminal disappears. A switched, replaced or cold session refuses this
control; inspect it rather than retrying physical closure.

`clankie herdr agent list` shows every worker's `owner` conversation (or
`unowned`) and, from a seat with `CLANKIE_CONVERSATION_ID`, `mine: true|false`.

## Uncertain hires

An uncertain hire may already have taken effect: inspect the retained receipt
and original pane, and never replay its brief, change its cwd, model, harness or
project, delete receipts or rewrite project-hire state files to escape a fence.
A freshly named Codex root may defer its first history read only while proving a
new, idle, non-forked root before first dispatch; never create or repair a
rollout file to bypass this. A post-dispatch history failure is uncertain.

`clankie hire-receipt settle UUID DISPOSITION` is the operator boundary (the
lead tool `settle_hire_receipt({receiptId, disposition})` settles only its own
conversation's fresh hires):

- `abandoned` for a local hire whose original pane, in this machine's complete
  Herdr inventory, holds no harness; a live harness refuses — adopt or retire it.
- `adopt` for a local hire that launched but never confirmed (for example stopped
  at `trust_required` and trusted by hand); the harness must run in the hire's own
  pane and directory. Brief delivery stays unknown, so message the worker to
  confirm the task or retire it with `close_worker_pane`.
- `release-allocation` for an inactive, unconfirmed project allocation held after
  a refusal, once a complete inventory shows neither its pane nor a worker there.
- Remote fenced hires: only a host-authenticated, recorded no-launch window
  settles; settlement permanently blocks the original key.

Separately authorized new remote work after settlement uses `hire_agent` with
`freshIntent: {id, afterReceiptId}` (or `clankie hire-receipt fresh
--json-stdin`): choose one new UUID, keep it across uncertainty, and name the
exact settled UUID at the same fleet/harness/cwd. Dispositions, evidence
requirements and a JSON example are in `docs/cli.md` under `hire-receipt`.

## Codex and Claude worker control

Local briefed Codex hires use a private app-server and remain native interactive
Codex seats in Herdr. Briefs and `message_seat` use protocol receipts; completion
comes from turn events, and the owner can type into the same bound session. The
app-server survives a Clankie service restart, and completed local launch
registrations persist under the service's state root, so the same live worker can
still report with `message_clankie` after a restart or re-pin. Clankie loses the
adapter's in-memory turn state on restart; inspect the pane and transcript before
relying on a new delivery. Never reconstruct membership from a claimed PID or
switch to an operator bearer. Codex messages can steer an active turn; a
`steered` receipt is not an after-turn queue.

Remote and Windows Codex control requires fresh native process, pane/session,
private-home and connected-endpoint proof, rechecked immediately before sending;
a timeout means undelivered and late approval cannot send. The SSH `codex queue`
fallback runs only after fresh proof that the pane uses the account's default
`~/.codex` standalone TUI; private or unproved homes refuse it, a private native
receipt never authorizes a second send, and an unavailable endpoint grants no
tools or authority to another session. A message too long for a Windows command line is
staged in full under `%USERPROFILE%\.clankie\seat-messages\` and the queued
message points to it; a failed staging is not-sent. A proven pre-launch
transport failure returns undelivered; a reset, timeout or lost native
acknowledgment remains uncertain and must not be replayed. Automated briefs and
messages never fall back to terminal typing. A saved Codex session reference
alone cannot recover in-memory control after a service restart.

Remote hire addresses include their fleet (`<fleet>/wC:p2`); the native host
census uses the bare pane (`wC:p2`). Both forms refer to the same pane only within
that exact registered fleet. A legacy bare allocation or missing original process
proof stays unconfirmed; it cannot become an owner-started workspace member
through address normalization.

Briefed local Claude hires use the approved `clankie-worker` channel and report
`control.mode: "channel"`; Codex, supported OpenCode workers and prepared Pi
report `adapter`. Missing structured control reports `unavailable` with
`control.reason` (and `control.fix` when owner action is needed). `terminal` is
only an unbriefed native launch. Folder trust and channel consent remain owner
decisions; a visible prompt does not authorize sending it keystrokes or launching
a replacement.

does not authorize sending it keystrokes or launching a replacement.

For `brief_delivery_unverified`, inspect `hire_agent.receipt_rejected` in the
service log: it names the session, transcript path (null if no file exists), and
the rejecting rule. Do not assume the newest matching transcript belongs to the
failed hire. Claude writes channel receipts as internal `isMeta`/system user
records. A standalone `clankie-seat` bridge must not poll when only the worker
plugin's channel is selected, or it can consume mail Claude never receives.

## Pi worker control

Prepared Pi is off by default on owner-run bodies; managed body images enable it.
Only `CLANKIE_PI_NATIVE_ENABLED=1` in the service's environment registers its
local adapter; changing it and restarting remain owner actions. Pi must pass
native capability and model/authentication checks in the same `worker_accounts`
report as Claude/Codex (`clankie accounts workers`); a disabled row does not
establish native authentication, and an expired OAuth credential in the separate
native Pi profile is refreshed by the owner in Pi. An owner hold excludes Pi
`default` from automatic selection. Opt-in uses whatever Pi is installed (at
least 0.87.1, passing the hire-time capability probe); a refused release shows
`Native Pi VERSION ...` with the failed surface — report that reason rather than
downgrading Pi. Prepared Pi workers consume `clankie mcp --fleet` through their
original native extension; controller or MCP process loss ends the consumer, which
never reconnects, retries an uncertain tool call or hires a replacement. Current
acceptance status: `{repoRoot}/docs/testing/2026-10-04-pi-workers/README.md`.

## OpenCode worker control

A local `hire_agent` may select `opencode` with the installed direct native binary
on macOS: any release at or above **1.18.18** whose worker probe passes. A probe
failure refuses the hire with the found version and the missing surface; report
that refusal to the owner rather than downgrading OpenCode or retrying. `model` is
`provider/model`; `effort` requires that model and a supported native variant.
Account, skill, Chrome and extra-argv overrides are refused. Its worker MCP uses
the fleet projection, without operator authority. Permissions and questions remain
owner decisions.

Accepted means native queue receipt; completion requires the matching finished
native reply. Never retry an uncertain start or send. A route switch or endpoint
loss retires control without adopting a replacement. Cold, replaced or switched
sessions refuse exit control, with no unconditional physical pane-close fallback.

On a linked Mac POSIX fleet, pass its `fleet` ID to `hire_agent`; the remote
machine needs Node 24+, Python 3, Herdr, native OpenCode 1.18.18 or newer that
passes the same probe, and its existing Clankie fleet link. Disconnects and
retargets refuse without local fallback or reconnect. Windows remote OpenCode
remains unsupported. Registered history (`<fleet>:ses_…` remotely) is read with
`clankie agents list|read`; `clankie agents resume … --conversation ID` requires
the original live controller and fresh identity/cwd checks. History is bounded
stored content, not proof of current TUI selection or control. Acceptance status:
`{repoRoot}/docs/testing/2026-10-04-opencode-workers/README.md`.

## Grok Build worker control

Grok Build native control requires macOS and the installed Grok at 1.0.46 or
newer. Each connection probes the leader IPC (protocol 1 with `control_v1`) and
ACP (protocol 1 with session loading) and requires one version across
`grok --version`, the leader and its agent; a failure names the found version
and what it lacks, and nothing is briefed. Review
`clankie grok --dry-run`; launch uses the current `GROK_HOME`
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

## Prime Agent worker control

Hire with `harness: "prime"` on this Mac (macOS or Linux, Prime Agent 0.10.x).
The owner signs Prime in to its providers; a hire uses those sign-ins, never a
key from Clankie. Name models as Prime does: `anthropic/claude-sonnet-5`,
`openai-codex/gpt-5.5` for a ChatGPT subscription, or a bare id Prime resolves.
`effort` is Prime's thinking level (`off` to `max`). Clankie creates the session,
then the pane runs `prime-agent attach` on it, so the owner sees and can type into
that exact session. Prime workers reach your tools from their Python REPL as MCP
server `clankie` and report with `message_clankie`. `message_seat` to a busy
worker queues by default and steers only when asked. Ending control leaves the
session resident in Prime's agents view; it is not killed. Remote fleets,
Windows, and reattaching after a service restart are unavailable; report that
instead of retrying. Details: `{repoRoot}/packages/agent-hosts/README.md`.

## Worker execution locations

Use `clankie runtime list` to inspect execution policy. The operator configures
extra locations with `clankie runtime workspaces ID --repo /checkout --dir /scratch`
(or `--clear`); each call replaces that runtime's extras. Repository approval pins
Git's common directory and permits its current registered worktrees; a directory
entry is exact, never a prefix. The caller conversation directory remains the default.
Use the actual approved checkout as the hire's `workingDirectory`. Workspace
changes use the operator endpoint; a hire cannot grant itself another location.
Capacity is configured per runtime with `clankie runtime capacity ID N|--clear`.

## Fleet responsibility settings

`clankie fleet status` shows global `fleet.closure` and `fleet.machineSetup`;
`clankie project settings PROJECT` shows that project's independent overrides
and effective values. Both default to `lead`. `clankie fleet set --closure
lead|owner --machine-setup lead|owner` changes the defaults. Use `clankie project
settings PROJECT --closure lead|owner|inherit --machine-setup lead|owner|inherit`
to override or restore inheritance for either field.

Closure `lead` lets the lead close landed, verified work; `owner` parks
delivered work for the owner. What each means for an issue's status is in
`work-items` under "Status stays true". Never mark unperformed work or missing
verification as passed.

Machine setup `lead` permits Clankie's own harness plugins, bridges and worker
setup on already-linked machines through existing authorized access. `owner`
requires approval. These settings never grant sign-ins, codes, CAPTCHAs,
payments, account changes, credentials or destructive actions outside fleet
workspaces. They neither restart nor steer existing lanes.

## Cross-device agent conversations

Messages includes seats from registered execution fleets. Opening a remote seat
reads its native history on demand over the fleet's SSH connection; replies use
that seat's qualified fleet address. `clankie conversations show ID` reads the
same conversation API. Remote native images are not
published through the local file service.

New native Queue sends stay host-owned until pickup. Use `clankie conversations
pending ID` for ordered original IDs/versions and outcomes; `edit`, `remove` and
`send-now` select that exact message with `--version N`. A picked-up or uncertain
original is never resent. After service restart, queued messages require explicit
send-now. `clankie conversations stop-task ID` stops an exact controller-owned
Codex turn; other native harnesses currently return unsupported. No terminal keys,
signals or lane restart are a fallback. These are operator/device-terminalControl
operations; worker captain credentials grant no authority. Full commands and
receipt states: [CLI reference](../../../../docs/cli.md#native-pending-messages-and-stop).

## Hiring and hearing from another machine

`hire_agent` with `fleet` and a granted `workingDirectory` briefs a remote Codex
or Claude worker over its native channel, as locally; nothing is typed into its
pane. Codex gets its own app-server on that machine through his ssh. Claude uses
the `clankie-worker` plugin over the fleet's link, so a briefed remote Claude
hire fails with the fix until `clankie herdr prepare NAME` has prepared
that linked machine. Machine setup policy, source-managed Codex setup and verification are in
[preparing linked machines](worker-bridges.md#preparing-linked-machines). This
does not grant operator CLI credentials to fleet workers. `herdr fleets` reports
each link's state. Setup never restarts or steers existing lanes.

A remote hire takes its project from the hiring conversation; a project
conversation's project stays pinned. From a conversation without one (the global
operator seat), the folder must be a registered project workspace on that machine,
spelled exactly as the machine spells it: `clankie project add PROJECT --workspace
PATH --machine FLEET --platform windows|posix`. A workspace registered under any
connection to the same machine counts. The fleet's own grant (`clankie runtime
workspaces FLEET --dir PATH`) is a separate requirement.

Accounts on another machine are that machine's own: its default Claude profile
and Codex home plus every `~/.claude-<label>` and `~/.codex-<label>`. The
`worker_accounts` tool (`clankie accounts workers --machine ID`, `GET
/v1/worker-accounts?fleet=ID`, the `/accounts` menu) asks the machine through
the fleet link: identity, plan, Codex headroom, worker plugin per Claude profile,
holds and `usable` or why not. Nothing secret crosses. A remote `account` is used
exactly (as that pane's `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, and the remote Codex
app-server's) or refused naming the machine, profile and the sign-in command to
run there; omitted, Clankie takes a usable, unheld account. The default Claude
home launches without `CLAUDE_CONFIG_DIR`, exactly as the probe read it: Claude
keys its keychain credential by that variable, so setting it even to `~/.claude`
selects a different sign-in. A home whose sign-in Claude refuses reports
unusable with its sign-in command, and a hire whose first turn Claude refuses
(`authentication_failed`) fails `harness_unavailable` with `sign_in_failed`. A Claude profile
signed in later needs `clankie herdr prepare NAME` once if its worker plugin is
missing. Signing in is the owner's step on that machine.

## Peer messages

With `fleet.peerMessages: "on"` (default), a proven native worker discovers
same-fleet peers using `list_fleet_seats({})`, then sends
`message_peer({seat: returnedSeatId, text})`. Use the returned fleet-qualified
terminal ID, for example `<fleet>/term_…`; never construct one from a local pane.

Peer content carries `source: peer`, is untrusted agent output and does not wake
Clankie. Both peers retain their assignments and lead. An uncertain send keeps
its original receipt; never resend by changing bridges or typing into a pane.
The owner can disable discovery/new sends with `clankie fleet set
--peer-messages off`; receipt reconciliation remains available.

## External agent history

Herdr discovery is identity and status, not transcript enrollment. Inspect panes
through Herdr and message supported seats through their native control. The fleet link
can coordinate independent enrolled peers. The app's native agent chats read the
harness history on demand through replay/tail; viewing one does not call Clankie
or copy its transcript into his event log. Explicit sends and native messages are
host-owned communications.

Native subagent tray history is read-only. `subagent_replay` takes the parent's
existing seat/persona `conversationId` plus `subagents.recent[].id` inside its
`replay` request; it needs the chat grant and returns the ordinary normalized
replay page. Claude IDs are parent task-call IDs, Codex IDs are child thread
UUIDs, and OpenCode IDs are task-call IDs. The server resolves them through the
addressed local parent; never use labels or list positions as addresses. Missing
IDs on older hosts remain display-only. Missing native locators and remote child
history report unavailable. Reading a child does not create, resume or steer a
conversation.

The fleet snapshot's `edges` include confirmed native peer delivery UUIDs and
verbatim bounded excerpts. `leadVisits` records confirmed captain deliveries and
pane closure separately. Uncertain, refused and merely stored peer attempts earn
no exchange; read the original receipt to reconcile, never resend for a visual.
These bounded five-minute facts describe delivery, not work completion.

## Chats, agents, rooms, and history

In the TUI, `/chats` means personal/workspace chats with Clankie; `/agents`
means known identities with connection source and availability; `/rooms`
means group channels and Discord inspection; `/history` means all retained
threads, including ongoing ones. `/conversation` and `/chat` alias `/chats`.
Use `/history ID` to open any retained thread. `/sessions` browses saved harness
sessions, which are not agent identities. Existing `/agents` session arguments
still work. Headless: `clankie agents contacts` lists identities and availability;
`clankie sessions` browses harness records; `clankie conversations list|show|tail`
reads retained threads. Never infer reachability or completion from a saved thread.

`clankie agents resume HOST:SESSION --conversation ID [--fleet ID] [--brief TEXT]` reopens a saved
history as an ordinary native Herdr seat, or reuses its existing seat. The same
operation is `hire_agent` with `resume: "host:sessionId"`, the saved harness and
workingDirectory. Remote resumes require the exact matching SSH destination,
shell and workspace grant; local Codex resumes keep their original account.
`delivery_unconfirmed` and `start_unconfirmed` may have taken effect: inspect the
named pane, never dispatch a replacement or replay the brief blindly. A saved
session in an unregistered terminal must be closed there before resuming.

Fleet contact reads (`clankie agents contacts`) accept up to 768 occupied seats
across connections and refuse larger complete reads rather than silently
truncating them. `readWarnings` means cached or partial observations, not
confirmed live ownership. Display input capabilities do not authorize a send;
the send performs its own fresh native and authority checks.

## Bundled working skills

Read `docs/bundled-skills.md` under the `repoRoot` reported by doctor for the
inventory and source revision. Local Claude hires receive a skills-only plugin,
Pi hires an explicit skill path, and Codex hires a private home overlay. The
operator Claude seat retains the full Clankie plugin. No global skill installation
is needed for these local launches after the service reloads the change.
Remote hires have their own coverage limits documented there;
do not infer full-bundle delivery from a successful local canary.

## Worker MCP servers

A local Claude or Codex hire starts Clankie's worker bridge, the MCP servers its
checkout declares (`.mcp.json` for Claude, `.codex/config.toml` for Codex), and
only the owner's own servers its hire profile names in `mcpServers`. Opt-ins add
up across `fleet.hire`, the project role and the hire. Every other server in the
owner's configuration stays off for that session; the owner's files and their
own sessions are untouched.

- Every worker: `clankie fleet set --mcp-servers github,xcode` (`none` clears).
  One role: `clankie agents role ROLE --project ID --mcp-servers NAME,...`
  (`inherit` clears). One job: `hire_agent`'s `mcpServers`.
- Names are the harness's config keys, as `claude mcp list` or `codex mcp list`
  prints them.
- Claude enforces the list through `allowedMcpServers` in the launch settings,
  so other plugins' servers and claude.ai connectors stay off too; a
  `plugin:…` server cannot be named. Built-ins such as Claude in Chrome work.
- Codex switches off each user-level `[mcp_servers]` entry the list leaves out.
  Servers a Codex plugin contributes follow the owner's plugin settings. Codex
  computer use and its browser run through `node_repl`, so the reach card says
  to hire those seats with `mcpServers: ["node_repl"]`.
- Each Codex thread, native subagents included, starts its own copy of the
  hire's servers and keeps it while the thread stays loaded. A config reload
  restarts only a changed server. Running workers keep the servers they started
  with until they restart.
- Remote hires read their own machine's configuration and are unchanged.

Hires and watches belong to the exact conversation that admitted them. The host
persists that source before launch and routes completion there with current
grants. A worker persona, an inspected room, and a default conversation confer
no ownership. API `spawn_seat` requires the selected `conversationId`; ordinary
`hire_agent` gets it from the admitted host turn. Legacy saved sessions without
persisted owner proof cannot be claimed by choosing a conversation.

## Local discovery state

The local service and native worker bridge share `CLANKIE_STATE`; discovery is
in its `links` directory, defaulting to `~/.clankie/links`. Local hires receive
the absolute service state path. An explicit private state directory never
falls back to the shared descriptor. Doctor uses the same state selection.
SSH fleets retain their own machine's state; no local state path is sent there.

## Project work policy

Use `clankie project settings PROJECT --wip-cap 6 --owner-loop milestones` for a
Started-issue cap and Auto reports. `none` clears the cap; `inherit` restores the
default milestone cadence. `silent` requests no owner reports; `landings` also
reports newly observed commits. Measurement continues in all modes.

Read/update project `hiring` through the same API (`includeWorkPolicy=true`,
`projectWorkPolicy:true`); lead/worker profiles and allowed/excluded plans/models
constrain new hires. Merge the read whole `hiring` object before a nested edit.
Fresh work hires need per-job `effortReason` and a selected effort; fleet-wide
effort is retired. Observed Claude/Codex usage must be fresh (five minutes), above
the 10% running-work reserve, and allowed by the project. Unknown usage refuses
new admission. Receipts and the project hire journal record the choice.

Fleet size/model mode, verification mode, reporting style and fleet-wide effort
are retired from settings editors. Previously saved values remain read-only in
`retiredWorkingPreferences`; they no longer promise enforcement. Actual task and
landing checks remain binding. Never edit live settings JSON directly.
