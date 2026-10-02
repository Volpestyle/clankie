# Fleet, hires and agent history

Hiring workers, skill selection for hires, Codex accounts, where workers run, and reading other agents' conversations.

## Optional working guidance

Opinionated skills are on by default. An owner turns them off with
`clankie skills opinionated off`, or uses `/skills` in the console. Product/tool
and repo-authored skills always remain. `clankie skills exclude NAME` removes an
individual opinionated skill; `include NAME` restores it when the class is on.
These settings apply to new sessions and local hires. Start a fresh Claude seat
or reset the service conversation to remove already-loaded guidance; no service
restart is needed for the setting itself. Never edit settings JSON directly.

Turning guidance off leaves Clankie able to lead using his own instructions and
native hire/message tools. Swarm is optional for independent enrolled peers.
Local `hire_agent` can use `skills: "plain"` or
`"bundled"` for a single hire; its result records the condition. Global/project
skills discovered independently by a harness are outside Clankie's bundle switch.

Extra Codex accounts are registered homes: `clankie accounts codex add HOME
--label LABEL`, `list`, and `remove LABEL` (also `/accounts codex` in the TUI).
The owner signs in and trusts hooks in that home; never copy credentials or
approve hook trust for them. Local Codex hires choose the most headroom across
the windows returned by Codex’s read-only quota API, including weekly-only plans.
Recent rollout usage is the fallback if that query fails. Missing or stale usage is unknown,
not an empty plan. `hire_agent` can pin `account: "LABEL"`; the hire and roster
report the chosen account. Registration changes apply to new hires only.

Local briefed Codex hires use a private app-server and remain native interactive
Codex seats in Herdr. Briefs and `message_seat` use protocol receipts; completion
comes from turn events, and the owner can type into the same bound session.
Codex messages can steer an active turn; a `steered` receipt is not an after-turn
queue. Other routes need a supported native channel or session API. Automated
briefs and messages never fall back to terminal typing. An uncertain start or
delivery retains its pane for inspection; reconcile it before retrying. A saved
Codex session reference alone cannot recover its in-memory control after a
service restart. Never replay uncertainty through another delivery path.

Briefed local Claude hires use the approved `clankie-worker` channel and report
`control.mode: "channel"`; Codex reports `adapter`. Missing structured control
reports `unavailable` with `control.reason` (and `control.fix` when owner action
is needed). `terminal` is only an unbriefed native launch. Each hire logs its
lane. Folder trust and channel consent remain owner decisions; a visible prompt
does not authorize sending it keystrokes or launching a replacement.

For `brief_delivery_unverified`, inspect `hire_agent.receipt_rejected` in the
service log: it names the session, transcript path (null if no file exists), and
the rejecting rule. Do not assume the newest matching transcript belongs to the
failed hire. Claude writes channel receipts as internal `isMeta`/system user
records. A standalone `clankie-seat` bridge must not poll when only the worker
plugin's channel is selected, or it can consume mail Claude never receives.

## Worker execution locations

Use `clankie runtime list` to inspect execution policy. The operator configures
extra locations with `clankie runtime workspaces ID --repo /checkout --dir /scratch`
(or `--clear`); each call replaces that runtime's extras. Repository approval pins
Git's common directory and permits its current registered worktrees; a directory
entry is exact, never a prefix. The caller conversation directory remains the default.
Use the actual checkout as `swarm_assign.contract.worktree`; do not falsify it to
match a route or change conversation identity. A blocked result lists the canonical
request and each candidate's allowed worktrees/reasons. Workspace changes require
the operator endpoint; Swarm tools cannot grant themselves another location.
A `restart-required` owner needs a coordinated update, not duplicate dispatch.

Dispatch budget and each runtime capacity default to 16. The owner can change either:
`clankie runtime capacity ID N` sets a runtime limit and `clankie runtime budget N`
sets the overall budget. Replace `N` with `--clear` for unlimited; `0`
pauses new admission. The TUI accepts the same arguments after `/runtime`.
Both counts apply per coordinator scope, including runtime capacity: two
coordinators sharing one Herdr runtime can together exceed its configured limit.
Settings are reconciled into existing owners without replacing in-flight receipts.
`runtime status` reports each effective value and its source: default, owner or unlimited.
These controls use the operator API; no Swarm tool or captain bearer can change them.

## Cross-device agent conversations

Messages includes seats from registered execution fleets. Opening a remote seat
reads its native history on demand over the fleet's SSH connection; replies use
that seat's qualified fleet address. `clankie conversations show ID` reads the
same conversation API. Swarm relay traffic does not import harness history.
Internal `clankie:<conversation>` and runtime-controller Swarm contacts are hidden
from the roster without deleting saved threads. Remote native images are not
published through the local file service.

## External agent history

Herdr discovery is identity and status, not transcript enrollment. Inspect panes
through Herdr and message supported seats through their native control. Swarm
can coordinate independent enrolled peers. The app's native agent chats read the
harness history on demand through replay/tail; viewing one does not call Clankie
or copy its transcript into his event log. Explicit sends and Swarm messages are
host-owned communications.

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

`clankie agents resume HOST:SESSION [--fleet ID] [--brief TEXT]` reopens a saved
history as an ordinary native Herdr seat, or reuses its existing seat. The same
operation is `hire_agent` with `resume: "host:sessionId"`, the saved harness and
workingDirectory. Remote resumes require the exact matching SSH destination,
shell and workspace grant; local Codex resumes keep their original account.
`delivery_unconfirmed` and `start_unconfirmed` may have taken effect: inspect the
named pane, never dispatch a replacement or replay the brief blindly. A saved
session in an unregistered terminal must be closed there before resuming.

## Bundled working skills

Read `docs/bundled-skills.md` under the `repoRoot` reported by doctor for the
inventory and source revision. Local Claude hires receive a skills-only plugin,
Pi hires an explicit skill path, and Codex hires a private home overlay. The
operator Claude seat retains the full Clankie plugin. No global skill installation
is needed for these local launches after the service reloads the change.
Remote hires and Swarm dispatch have separate coverage limits documented there;
do not infer full-bundle delivery from a successful local canary.
