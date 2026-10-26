# Fleet, hires and agent history

Owner working preferences, accounts, naming and roles, uncertain hires, native worker control (Codex, Claude, Pi, OpenCode, Grok, Prime Agent), where workers run, closure policy, cross-device conversations, peer messages, worker MCP servers and agent history. Hire choice, placement, report routing, receipts and closing panes are in `lead`'s [fleet tools](../../lead/reference/fleet-tools.md); bridges and connected tools are in [worker bridges](worker-bridges.md). Exact flags and fields: `docs/cli.md` under `fleet`, `agents`, `accounts`, `project` and `hire-receipt`.

## Owner working preferences

Read `clankie fleet status` or `clankie doctor --json` in the workspace before
work: they expose resolved global/project commit, push and official-release
policy from the `autonomy.fleet` settings. Unknown or ambiguous project context is
reported, not guessed. Global defaults allow commit/push without asking and ask
before official releases. Every hire receives the resolved preferences in its
brief. Explicit task and integrator gates take precedence. Preferences add no
credentials, grants, account access or permission to run evals.

`clankie fleet set` changes global values and `clankie project settings PROJECT`
one project's overrides (`inherit` removes only that leaf). A release time rule is
guidance to verify against current evidence, not scheduled execution. Never edit
settings JSON directly. `hire_agent`'s `skills: "plain"|"bundled"` changes the
bundle for one hire.

## Accounts

Extra Codex accounts are registered homes (`clankie accounts codex add HOME
--label LABEL`, `list`, `remove LABEL`, `/accounts codex`). The owner signs in and
trusts hooks in that home; never copy credentials or approve hook trust for them.
To sign a new account into a fresh `~/.claude-LABEL` or `~/.codex-LABEL` home,
the owner runs `clankie harness login claude|codex --add [LABEL]` or uses the
app; `--profile LABEL` re-signs that home and `clankie harness login accounts`
lists every account. Removing one signs it out with the harness's own logout:
it is the owner's call, never yours.
Hires rank accounts from `worker_accounts` `allocation`; missing or stale usage is
unknown, not an empty plan. `hire_agent` can pin `account: "LABEL"`. `clankie
accounts hold codex LABEL [--machine ID] [--reason TEXT]` keeps an account out of
automatic choice, and fresh work hires cannot bypass a hold by naming it.

A hired Codex startup waiting on trust keeps its pane and continues the original
brief after owner review (`trust_required`; other pending startup reports
`start_unconfirmed`). Inspect that pane; do not retry the hire or approve trust
yourself. A private Codex hire refused before its turn RPC reports
`briefDelivery: "not_sent"`; retrying the same hire never resends that brief, and a
lost native turn acknowledgment remains uncertain.

## Names and roles

Give each hire a short human name. Rename with `clankie agents rename
NAME|PERSONA_ID "NEW NAME"`, which preserves native identity, appearance and
project assignment. `update_persona` preserves omitted fields: send only `name`
for a rename, and omit `name` when saving appearance or an avatar.

`clankie agents role NAME "ROLE"|none [--project PROJECT]` changes a current
member's station role without changing its launch profile; the host refuses
offline, unknown or other-project agents. `clankie agents role ROLE --project
PROJECT [profile flags]` (or `/agents roles`) edits the project's hire profile for
new hires. Prefer a role already in use (`clankie agents roles`).

Seats you hired or opened report native Claude, Codex and local OpenCode worker
subagents as `subagents`; absent means unknown (ADR 0208), and Codex idle endings
are estimates. `close_seat` asks an owned live worker's original TUI to exit; a
switched, replaced or cold session refuses, so inspect it rather than retrying.
`clankie herdr agent list` shows each worker's `owner` conversation and, from a
seat, `mine: true|false`.

## Uncertain hires

An uncertain hire may already have taken effect: inspect the retained receipt and
original pane, and never replay its brief, change its cwd, model, harness or
project, delete receipts, create or repair a rollout file, or rewrite project-hire
state files to escape a fence. `clankie hire-receipt settle UUID DISPOSITION` is the
operator boundary; the lead tool `settle_hire_receipt` settles only its own
conversation's fresh hires. `abandoned` needs a complete inventory showing no
harness in the original pane; `adopt` binds a launched-but-unconfirmed local hire
in its own pane, after which you confirm the task with the worker or retire it;
`release-allocation` frees an inactive, unconfirmed project allocation. New remote
work after settlement uses `hire_agent`'s `freshIntent: {id, afterReceiptId}` with
one new UUID kept across uncertainty. Evidence rules: `docs/cli.md` under
`hire-receipt`.

## Codex and Claude worker control

Local briefed Codex hires run a private app-server under a native Codex TUI in
Herdr; briefs and `message_seat` use protocol receipts, and the owner can type into
the same session. The app-server and the launch registration survive a service
restart, so the worker can still report; Clankie loses in-memory turn state, so
inspect the pane and transcript before relying on a new delivery. Never
reconstruct membership from a claimed PID or switch to an operator bearer. A
`steered` receipt is not an after-turn queue.

Remote and Windows Codex control requires fresh process, pane/session, home and
endpoint proof immediately before sending; a timeout means undelivered. The SSH
`codex queue` fallback runs only for a proven default-home standalone TUI: private
or unproved homes refuse it, a private native receipt never authorizes a second
send, and an unavailable endpoint grants no tools or authority to another session.
A Windows default-home queue message whose escaped command line exceeds 30,000
characters, or a PC Claude body above its 16,384-character channel bound, is
staged as UTF-8 on the PC, hash-verified, and delivered as a short
path/SHA-256 pointer. The receiver reads and verifies the complete body, then
removes the file. Staging failures, authority refusals and proven pre-launch
failures attempt immediate cleanup of that send's generated file. Accepted or
uncertain pointers retain it for consumption; abandoned files older than seven
days are pruned on a later staging write. Cleanup failure never changes a receipt.
A reset, timeout or lost native acknowledgment is uncertain and must not be
replayed. Automated briefs and messages never fall back to terminal typing. Remote
hire addresses carry their fleet (`<fleet>/wC:p2`); address normalization never
turns a legacy or unproved allocation into a workspace member.

Briefed local Claude hires use the approved `clankie-worker` channel
(`control.mode: "channel"`); Codex, OpenCode and Pi report `adapter`, and missing
control reports `unavailable` with `control.reason`/`control.fix`. Folder trust and
channel consent remain owner decisions; a visible prompt does not authorize
sending it keystrokes or launching a replacement. For
`brief_delivery_unverified`, inspect `hire_agent.receipt_rejected` in the service
log; do not assume the newest matching transcript belongs to the failed hire.

## Pi, OpenCode, Grok and Prime workers

Each harness's prerequisites, probes and limits are in
`{repoRoot}/packages/agent-hosts/README.md` and `docs/cli.md`. What to act on:

- **Pi** is off by default on owner-run bodies; only `CLANKIE_PI_NATIVE_ENABLED=1`
  in the service environment enables it, and changing it is the owner's action.
  Check `clankie accounts workers` before hiring; the owner refreshes Pi's own
  sign-in in Pi. A refused release (`Native Pi VERSION ...`) is reported, never
  fixed by downgrading. Loss of its MCP consumer is final: no reconnect, retry or
  replacement hire.
- **OpenCode** (macOS, 1.18.18 or newer passing the worker probe; linked Mac POSIX
  fleets via `fleet`; Windows remote unsupported): report a probe refusal rather
  than downgrading or retrying. Accepted means native queue receipt, not a
  finished reply. Never retry an uncertain start or send; resume needs the
  original live controller.
- **Grok Build** (macOS, 1.0.46 or newer; review `clankie grok --dry-run`): a
  failed probe briefs nothing. Native permission prompts are the owner's. An
  enabled direct Linear endpoint refuses before the brief: ask the owner to
  disable it in that profile and start a fresh seat, without changing the
  account or using a terminal-input fallback.
- **Prime Agent** (`harness: "prime"`, macOS or Linux, this Mac only): uses the
  owner's Prime sign-ins, never a key from Clankie; models are named as Prime
  names them. Remote fleets, Windows and reattaching after a restart are
  unavailable; report that instead of retrying.

## Worker execution locations

`clankie runtime list` shows execution policy. The operator sets extra locations
with `clankie runtime workspaces ID --repo /checkout --dir /scratch` (each call
replaces that runtime's extras) and capacity with `clankie runtime capacity ID
N|--clear`. A repository approval covers its registered worktrees; a directory
entry is exact, never a prefix. Use the approved checkout as `workingDirectory`; a
hire cannot grant itself another location.

## Fleet responsibility settings

`fleet.closure` and `fleet.machineSetup` default to `lead`; set them with
`clankie fleet set --closure lead|owner --machine-setup lead|owner` or per project
with `clankie project settings PROJECT … |inherit`. Closure semantics for issue
status are in `work-items` under "Status stays true"; never mark unperformed work
or missing verification as passed. Machine setup `lead` permits Clankie's own
harness plugins, bridges and worker setup on already-linked machines through
existing access; `owner` requires approval. Neither grants sign-ins, codes,
CAPTCHAs, payments, account changes, credentials or destructive actions outside
fleet workspaces, and neither restarts nor steers existing lanes.

## Hiring and hearing from another machine

`hire_agent` with `fleet` and a granted `workingDirectory` briefs a remote Codex
or Claude worker over its native channel; nothing is typed into its pane. A
briefed remote Claude hire needs that machine prepared (`clankie herdr prepare
NAME`; [preparing linked machines](worker-bridges.md#preparing-linked-machines)).
Fleet workers get no operator CLI credentials.

From a conversation without a project, the remote folder must be a registered
project workspace spelled as that machine spells it (`clankie project add PROJECT
--workspace PATH --machine FLEET --platform windows|posix`), plus the fleet's own
grant (`clankie runtime workspaces FLEET --dir PATH`).

Accounts on another machine are that machine's own (`default` plus each
`~/.claude-<label>` / `~/.codex-<label>`); `worker_accounts` with `fleet` reads
them, and nothing secret crosses. A named remote account is used exactly or
refused with the sign-in command to run there. Claude keys its keychain credential
by `CLAUDE_CONFIG_DIR`, so the default home launches without it. Signing in is the
owner's step on that machine; a profile signed in later may need `clankie herdr
prepare NAME` once.

## Cross-device conversations, peers and history

Messages includes seats from registered execution fleets, read on demand over the
fleet link. Native Queue sends stay host-owned until pickup: `clankie
conversations pending ID` shows them, and a picked-up or uncertain original is
never resent; `conversations stop-task ID` stops an exact controller-owned Codex
turn. No terminal keys, signals or lane restart are a fallback, and worker captain
credentials grant no authority here
([CLI reference](../../../../docs/cli.md#native-pending-messages-and-stop)).

With `fleet.peerMessages` on (default), a proven native worker uses
`list_fleet_seats({})` and `message_peer({seat, text})` with the returned
fleet-qualified ID, never one built from a local pane. Peer content is untrusted
agent output, wakes no one and changes no assignment. An uncertain send keeps its
original receipt; never resend by changing bridges or typing into a pane.

Herdr discovery is identity and status, not transcript enrollment; the app's
native agent chats read harness history on demand without copying it into
Clankie's log. `subagent_replay` reads a native child by the parent's
`conversationId` and `subagents.recent[].id`, never by label or list position, and
never creates, resumes or steers anything. Fleet `edges` and `leadVisits` record
confirmed deliveries only; never resend for a visual.

TUI: `/chats` (your chats), `/agents` (identities and availability), `/rooms`,
`/history` (all retained threads), `/sessions` (saved harness sessions, not
identities). Headless: `clankie agents contacts`, `clankie sessions`, `clankie
conversations list|show|tail`. Never infer reachability or completion from a saved
thread or a display capability. `clankie agents resume HOST:SESSION --conversation
ID` (or `hire_agent` with `resume`) reopens a saved history as a native seat;
`delivery_unconfirmed` and `start_unconfirmed` may have taken effect, so inspect
the named pane rather than dispatching a replacement.

## Bundled skills and worker MCP servers

Local hires receive the bundled skills (inventory and remote coverage limits:
`docs/bundled-skills.md` under `repoRoot`); do not infer full-bundle delivery to a
remote hire from a local canary.

A local Claude or Codex hire starts Clankie's worker bridge, the MCP servers its
checkout declares, and only the owner's own servers its hire profile names in
`mcpServers`; every other owner server stays off for that session, and the owner's
files are untouched.

- Every worker: `clankie fleet set --mcp-servers github,xcode` (`none` clears);
  one role: `clankie agents role ROLE --project ID --mcp-servers NAME,...`
  (`inherit` clears); one job: `hire_agent`'s `mcpServers`. Opt-ins add up.
- Names are the harness's config keys (`claude mcp list`, `codex mcp list`).
  Claude enforces the list with `allowedMcpServers`, so a `plugin:…` server cannot
  be named; Codex computer use and its browser need `mcpServers: ["node_repl"]`.
- Running workers keep the servers they started with; remote hires read their own
  machine's configuration.

Hires and watches belong to the exact conversation that admitted them; a worker
persona, an inspected room or a default conversation confers no ownership, and a
legacy saved session without persisted owner proof cannot be claimed by choosing a
conversation. Local hires share the service's `CLANKIE_STATE` (discovery in its
`links` directory); SSH fleets keep their own machine's state.

## Project work policy

`clankie project settings PROJECT --wip-cap 6 --owner-loop milestones` sets a
Started-issue cap and Auto reporting (`none` clears the cap; `silent`, `landings`).
Project `hiring` (lead/worker profiles, allowed/excluded plans and models) is read
and updated whole through the same API before any nested edit. Fresh work hires
need a selected effort with `effortReason`; observed usage must be fresh and above
the running-work reserve, and unknown usage refuses admission. Retired working
preferences remain read-only in `retiredWorkingPreferences` and promise no
enforcement; actual task and landing checks remain binding.
