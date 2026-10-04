# Native harness commands

Open Clankie's operator seat with `clankie claude`, `clankie codex`, or
`clankie opencode`; the seat drives a selected Clankie conversation.

## Launch and resume

`clankie claude2` selects the owner's `claude2` account command. Numbered
Claude commands resolve aliases and functions through the interactive `$SHELL`
and accept the same seat flags.

`clankie claude` opens Claude Code as you, on your person's own plan, with your
tools over the `clankie` MCP server, your persona and memory card injected by
the plugin's hooks, and these skills as `/clankie:this-machine` and
`/clankie:trace-clankie`. Doctor's `laneTools` says whether the service's
`/v1/mcp` route answers; `clankie claude --dry-run` prints the launch plan
(`plugin.source` is `plugin-dir`, with the selected catalog and the
`clankie@inline` channel identity). The launcher allows this seat's Clankie CLI and plugin MCP tools while denying
independent tracker connectors. This avoids routine tool prompts; it does not
expand the selected conversation's authority. Folder/hook/channel trust remains
the owner's decision. The seat's own brain is Claude Code's `/model`;
`clankie model` changes the service lanes. Each fresh launch creates a separate
workspace chat, including multiple launches in the same directory or account.
Its transcript appears in that chat in the app; tools, self-wakes and herdr
watches follow its conversation as `<channel source="clankie">` events.
`--resume` retains the last seat's chat for the selected Claude command.
`--dry-run` creates no chat. With `--conversation global-default`, a seat inside
the service's herdr fleet claims the agent name `clankie` and becomes the shared
global head.

Find the selected conversation with `clankie conversations list`; native
`--conversation` accepts its stable ID, exact title or unambiguous Discord
target/channel ID. Each server channel and DM has its own conversation. Attaching
to `global-default` affects only that chat; attach to the room's conversation to
drive its turns. A live seat receives worker reports, escalations, wakes and
watches through its channel. After it leaves, new inputs use the service runner.
An accepted or uncertain delivery is never replayed across that handover.
Pi goal continuations keep their existing service loop.

Room replies keep the original actor's route and mouth lease. Attachment never
adds grants: a cached room MCP bank stays social without generic operator body
authority. Ordinary `send` and `reset` still refuse room conversations.

`clankie codex --conversation ID` opens the same operator seat
in the real Codex TUI, using the Codex plugin and a dedicated app-server thread.
In a checkout, first run `node integrations/codex-plugin/build.mjs` to materialize
the shared skills; release bundles already contain them. Install with
`codex plugin marketplace add <install-root>/integrations/codex-plugin`
and `codex plugin add clankie@clankie-seat`; keep it disabled globally in `/plugins`.
The launcher enables it for this seat. The owner must review and trust its hooks
in `/hooks`, then exit and repeat the original launch command. Use `--resume` after its first turn.
Never bypass hook trust or write trust hashes. New or changed hooks need review.
Wakes, watches and escalations use the same conversation outbox and the native
thread's turn delivery; the launcher waits for trusted startup hooks before
binding it. Codex's `/model` selects the seat brain. Its resume record is separate
from Claude's. For a live check, create a scratch conversation and close your own
seat afterward; never use the owner's global-default thread.

`clankie codex2` selects the registered account labelled exactly `codex2`:
`clankie accounts codex add /absolute/CODEX_HOME --label codex2` registers it.
The number is part of the label, never an account-list position. Unknown labels
fail without selecting another account. The launcher captures the canonical home
for native discovery, the app-server and TUI. Numbered commands keep separate
resume records and refuse to resume after their label is rebound to another home.
Plain `clankie codex` retains the current `CODEX_HOME` behavior. OpenCode has no
numbered account command.
For numbered accounts, set `CODEX_HOME` to that registered home in the environment
of native plugin installation commands and the Codex session used to review
`/plugins` and `/hooks`. Setup under a different home does not prepare this account.

Checkout-only procedures (`verify-clankie`, `release-clankie`, `pnpm check`)
exist only when doctor says `kind: checkout`.

Use the `clankie` MCP server for service tools. Select a project with
`clankie claude --conversation ID` to reuse an existing chat. A fresh launch without
that flag creates its own chat rooted at the launch directory. Owner preferences
and project instructions follow that conversation. Fresh Codex seats also get
separate chats; their resume record remains independent of Claude's.

Eligible Linear notifications use that channel in the conversation that owns the
issue. Successful conversation writes, `hire_agent` with canonical `linearIssue`,
and `clankie linear work bind --organization UUID --issue UUID --conversation ID`
establish ownership. `linear work list` reads it. Unowned/removed owners route to
`linear-inbox`; its `linear inbox handoff CURSOR` uses the current issue owner and
preserves the original wake decision. Read durable memory/work items/roster, not
other conversations' transcripts. Follow and attribution rules still gate wakes;
room ownership retains its original actor/route grants.
Replies to project/initiative status updates use the retained author of that exact
update. They can reach a native lead on a remote fleet through its existing channel,
with the original seat/occupant proof refreshed before dispatch. `linear work list`
also shows host-stamped native owners. Missing author proof stays in the inbox;
never infer it from the current pane name or replay uncertain delivery.
The launched Claude seat projects its settled transcript into the selected
conversation even outside Herdr or with `--plugin-dir`. `clankie seat-sync` is the
plugin hook; do not change its session binding to copy a transcript between rooms.
Viewed image paths are not portable; publish an intended file with `clankie file`.

Inspect all connections with `clankie connections` or `/connections`. Use
`clankie runtime list`, `runtime connect ID --session NAME` (or `--socket PATH`),
and `runtime disconnect ID` for named execution connections. Native local
inspection uses `clankie herdr --connection ID agent list`; opening a seat does
not select its runtime. Hire with `hire_agent`, deliver context with
`message_seat`, and track work in the repo's tracker. SSH fleets use the per-fleet
link (`clankie herdr prepare FLEET`); `runtime list` reports `linkState`.
The paired app exposes execution and account inventory in Settings → Connection.
Load `lead` for leadership and the fleet reference for native delivery.

Workers' `message_clankie` reports reach the conversation that hired them.
Messaging a worker with `message_seat` adopts it under the sending conversation;
its reports and completion watches then follow that lead. The service resolves
this persisted route, including remote fleet seats; the worker never chooses it.
Without persisted adoption, the host uses the exact census parent/launcher pane
and native occupant to reach its attached conversation or existing native
channel. Explicit adoption wins. With no eligible parent (or a removed adopted
conversation), `global-default` receives a report tagged `unadopted` with its
reason and parent pane when known. Read `workerReportRouting` on the roster and
durable accepted turn; `clankie doctor` names parent panes lacking an observed
bridge in `linkedSession.parentLeads`. Names, tabs and report text prove no
ownership, and bridge process observations prove neither tools nor delivery.
Revoked room grants or missing original room proof remain a refusal. Reconcile
the original receipt after uncertainty; adoption, detach and restart never
redirect an accepted report ID.

Native projection carries these reports as `kind="message"`, framed as
untrusted agent output, never an instruction from the owner. Completion harvests
stay `kind="watch"`; self-wakes stay `kind="wake"`. The tag changes neither
the retained owner route nor receipt semantics. A room-owned worker message
still needs the existing `reply` with its `event_id` to return a correlated answer
through that room's original actor, route and mouth checks.

For shared Linear tools, inspect `clankie access linear`; verify an API-key
or OAuth connection with `clankie access linear verify` and check the intended automation identity.
Admitted fleet members discover connected tools with `clankie_tools` and invoke
qualified names with `clankie_call`. The setting `fleet.tools` defaults to
`connected`; `clankie fleet set --tools off` stops new standing tool admissions.
Calls already past their last asynchronous check can still dispatch afterward;
VUH-1585's strict refusal guarantee remains unmet (ADR 0217).
Projects keep hiring, roles, caps and tracker policy, independently of tools.
Unverified accounts and persona-bound worker publishing are excluded. For an individual
manual grant, `clankie access issue REQUEST.json --out GRANT.json` creates a
private file for `clankie mcp --grant FILE`; tokens last at most 15 minutes.
Use `access list` and `access revoke ID` to inspect or revoke.
Never share operator bearers or grant contents in transcripts. Exact
`tools[].arguments` and `forbiddenArguments` enforce resource restrictions.
Worker publishing grants must pin the exact `personaId`. Read
`docs/worker-access.md` under `repoRoot` for the contract.

The worker bridge gives its first `tools/list` up to 20 seconds to retry with
backoff while native pane membership settles, including any stalled HTTP lookup.
Fleet admission and the connected-tools setting must permit discovery; otherwise
only `message_clankie` remains. Later lists and every call still check current
access. Codex currently keeps its initial catalog despite
`notifications/tools/list_changed`; after an access change, an owner may need to
reconnect MCP or restart that native pane. New calls from a displayed stale catalog are checked live; this is not a promise
that calls already past a final asynchronous check cannot dispatch after revocation.
Missing tools do not authorize another connector or an operator lane.
Native identity checks for worker messages, peer delivery and project assignments
remain separate from connected-tool admission. Connected tools require the linked
fleet and verified account, not a project or cwd proof (ADR 0217). Inspect the
specific refusal instead of treating every missing capability as a project grant.

OpenCode seats use the same isolation contract: a fresh `clankie opencode` creates a separate workspace chat; `--conversation ID` reuses one,
`--resume` keeps the exact native session and chat, and `--dry-run` creates none.
See [the OpenCode seat guide](../../../../integrations/opencode-plugin/README.md).

### Progress and interrupted replies

Claude and Codex seats upload redacted mid-turn progress after tool calls, at
most once per two seconds, and flush retained entries at Stop. A service restart
can interrupt the conversation link while the native seat continues working.
The app run reports `service_restarted`, not successful completion. Reply targets
are process-local: if `reply` reports that its target is gone, that answer was
not sent. Check the conversation and seat before sending again; never infer
that restart, transport acknowledgment, or queue consumption means the model
finished, and never automatically replay an uncertain request.

Doctor and the roster keep bridge transport presence separate from process age.
An observed bridge that started before the running service reports
`older-than-runtime`: “seat bridge older than runtime; restart the seat”.
`current` means its observed start is at least as recent as the service's;
unavailable runtime/process timing remains `unknown`. Optional `bridgeStartedAt`
and `runtimeStartedAt` are timestamps, not build identities. Age alone establishes neither obsolete
code nor delivery, and also changes after a same-build service restart. Doctor
observes operator and worker bridges separately; operator presence never grants
worker tools. Reconcile uncertain dispatch before another attempt.
