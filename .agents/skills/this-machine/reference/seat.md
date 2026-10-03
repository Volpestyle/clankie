# The seat

Claude Code or Codex sitting in Clankie's operator seat.

## The seat

`clankie claude2` selects the owner's `claude2` account command. Numbered
Claude commands resolve aliases and functions through the interactive `$SHELL`
and accept the same seat flags.

`clankie claude` (also `clankie seat`) opens Claude Code as you, on your person's own plan, with your
tools over the `clankie` MCP server, your persona and memory card injected by
the plugin's hooks, and these skills as `/clankie:this-machine` and
`/clankie:trace-clankie`. Doctor's `laneTools` says whether the service's
`/v1/mcp` route answers; `clankie seat --dry-run` prints the launch plan
(`plugin.source` is `plugin-dir`, with the selected catalog and the
`clankie@inline` channel identity). The seat's own brain is Claude Code's `/model`;
`clankie model` changes the service lanes. Each fresh launch creates a separate
workspace chat, including multiple launches in the same directory or account.
Its transcript appears in that chat in the app; tools, self-wakes and herdr
watches follow its conversation as `<channel source="clankie">` events.
`--resume` retains the last seat's chat for the selected Claude command.
`--dry-run` creates no chat. With `--conversation global-default`, a seat inside
the service's herdr fleet claims the agent name `clankie` and becomes the shared
global head.

`clankie seat --harness codex --conversation ID` opens the same operator seat
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

Checkout-only procedures (`verify-clankie`, `release-clankie`, `pnpm check`)
exist only when doctor says `kind: checkout`.

Use the `clankie` MCP server for service tools. Select a project with
`clankie seat --conversation ID` to reuse an existing chat. A fresh launch without
that flag creates its own chat rooted at the launch directory. Owner preferences
and project instructions follow that conversation. Fresh Codex seats also get
separate chats; their resume record remains independent of Claude's.

Followed Linear notifications use that channel when this seat owns the operator
conversation (`global-default`); issue bindings do not route wakes.
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

For shared Linear tools, inspect `clankie access linear`; verify an API-key
or OAuth connection with `clankie access linear verify` and check the intended automation identity.
Use `clankie access project PROJECT SERVER [--tool NAME]...` to grant connected
service tools to verified agents of that project until revoked. Actual native
hire assignments take precedence; otherwise the agent's actual cwd must be in
an approved project workspace. Old fleet grants no longer confer tools, and
remote links alone cannot prove project membership. For an individual
manual grant, `clankie access issue REQUEST.json --out GRANT.json` creates a
private file for `clankie mcp --grant FILE`; tokens last at most 15 minutes.
Use `access list` and `access revoke ID` to inspect or revoke.
Never share operator bearers or grant contents in transcripts. Exact
`tools[].arguments` and `forbiddenArguments` enforce resource restrictions.
Worker publishing grants must pin the exact `personaId`. Read
`docs/worker-access.md` under `repoRoot` for the contract.

OpenCode seats use the same isolation contract: a fresh `clankie seat --harness
opencode` creates a separate workspace chat; `--conversation ID` reuses one,
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
