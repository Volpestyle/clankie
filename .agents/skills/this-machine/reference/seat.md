# Native harness commands

Open Clankie's operator seat with `clankie claude`, `clankie codex`, or
`clankie opencode`; the seat drives a selected Clankie conversation.

## Launch and resume

Numbered commands select other accounts. `clankie claude<N>` runs the owner's
matching `claude<N>` shell command; numbered Claude commands resolve aliases and
functions through the interactive `$SHELL` and accept the same seat flags.

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
`clankie model` changes the service lanes. A fresh launch takes the shared global
chat while no live seat holds it; otherwise, or with `--new`, it creates a
separate workspace chat. Its transcript appears in that chat in the app; tools, self-wakes and herdr
watches follow its conversation as `<channel source="clankie">` events.
`--resume` retains the last seat's chat for the selected Claude command.
`--dry-run` creates no chat. A seat on the global chat inside the service's
herdr fleet claims the agent name `clankie` and becomes the shared global head.

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
For this operator seat, never bypass hook trust or write trust hashes. New or
changed hooks need review. A fleet hire separately authorizes the installed
Clankie worker plugin: its dedicated app-server trusts only those hooks' current
native hashes in the isolated worker home before launch. Other hooks retain
native review, and a review prompt keeps the hire's app-server connected.
Wakes, watches and escalations use the same conversation outbox and the native
thread's turn delivery; the launcher waits for trusted startup hooks before
binding it. Codex's `/model` selects the seat brain. Its resume record is separate
from Claude's. For a live check, create a scratch conversation and close your own
seat afterward; never use the owner's global-default thread.

`clankie codex<N>` selects the registered account labelled exactly `codex<N>`:
`clankie accounts codex add /absolute/CODEX_HOME --label codex2` registers `codex2`.
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
that flag takes the global chat when it is free, else creates its own chat rooted
at the launch directory (`--new` always does). Owner preferences and project
instructions follow that conversation. Codex seats choose the same way; their
resume record remains independent of Claude's.

Eligible signed Linear activity uses the existing seat channel of one configured
ordinary global chat, `global-default` by default; the lead receives the compact
wake and chooses any delegation. Target, follow and wake rules are in
[Linear activity and wakes](linear.md).

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

Worker reports reach the conversation that hired them; routing and adoption are
in [worker report routing](fleet-tools.md#worker-report-routing).

Native projection carries these reports as `kind="message"`, framed as
untrusted agent output, never an instruction from the owner. Completion harvests
stay `kind="watch"`; self-wakes stay `kind="wake"`. The tag changes neither
the retained owner route nor receipt semantics. A room-owned worker message
still needs the existing `reply` with its `event_id` to return a correlated answer
through that room's original actor, route and mouth checks.

Connected fleet tools and manual access grants are in
[worker bridges and fleet tools](fleet-tools.md).

### OpenCode operator seat

Use `clankie opencode --conversation ID --dry-run` to inspect the
native launch before sitting as Clankie; `--resume` binds the exact saved native
session. It is an operator seat, not an OpenCode `hire_agent` adapter. Native
wakes use the bound session API, wait while busy, and never type into an owner's
draft. Permissions stay with the owner. Uncertain delivery blocks every retry, including explicit retries, until its
original native receipt is reconciled. A service restart
does not reattach from a saved ID. See `integrations/opencode-plugin/README.md`
for per-launch MCP isolation, settings, version checks and current live gaps.

OpenCode seats use the same contract: a fresh `clankie opencode` takes the free global chat or creates a separate workspace chat; `--conversation ID` reuses one,
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
