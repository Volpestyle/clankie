# The seat

Claude Code or Codex sitting in Clankie's operator seat.

## The seat

`clankie seat` opens Claude Code as you, on your person's own plan, with your
tools over the `clankie` MCP server, your persona and memory card injected by
the plugin's hooks, and these skills as `/clankie:this-machine` and
`/clankie:trace-clankie`. Doctor's `laneTools` says whether the service's
`/v1/mcp` route answers; `clankie seat --dry-run` prints the launch plan
(`plugin.source` is `plugin-dir`, with the selected catalog and the
`clankie@inline` channel identity). The seat's own brain is Claude Code's `/model`;
`clankie model` changes the service lanes. Inside a herdr pane the seat is the
agent named `clankie`, and that pane is your head: the app's Clankie thread
shows its settled turns, and your self-wakes and herdr watches arrive there as
`<channel source="clankie">` events while it is open.

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
`clankie seat --conversation ID`; the launch directory alone does not change
the service conversation. Owner preferences and project instructions follow
that conversation.

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
Use `clankie access fleet FLEET SERVER [--tool NAME]...` to grant connected
service tools to agents in a linked Herdr session until revoked. For an individual
manual grant, `clankie access issue REQUEST.json --out GRANT.json` creates a
private file for `clankie mcp --grant FILE`; tokens last at most 15 minutes.
Use `access list` and `access revoke ID` to inspect or revoke.
Never share operator bearers or grant contents in transcripts. Exact
`tools[].arguments` and `forbiddenArguments` enforce resource restrictions.
Worker publishing grants must pin the exact `personaId`. Read
`docs/worker-access.md` under `repoRoot` for the contract.
