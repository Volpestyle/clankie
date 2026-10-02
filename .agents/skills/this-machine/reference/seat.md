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

In the Claude seat, use Swarm tools from the `clankie` MCP server. They share the
service conversation actor and task ownership. Use `clankie seat --conversation ID`
for an existing project conversation; omission uses the global head. Its service
workspace must exist on the native host. Resume preserves the selection. The
startup prompt includes owner/fleet preferences and that workspace's agent
instructions. The launch directory alone does not select a project scope.
Swarm messages use the plugin channel when enabled; acknowledge after processing.
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
not select its runtime. On embedded routed assignments, set `runtime: "ID"` to
select execution; `connection` selects the separate Swarm coordinator. Never
change either on a retry. For local managed workers, `clankie runtime harness ID
claude|codex|pi` selects the harness through the operator API and TUI Connections
menu. Codex uses `gpt-6-astra`; pi uses its native model preference. Codex/pi need
native-interactive support in the installed Swarm build. Native is the default;
legacy stream settings remain readable but disable new managed dispatch. The
integrated upstream source requires a coordinated package rollout before those
routes become available; never swap the active artifact while workers run.
`swarm_assign harness` explicitly
constrains the runtime choice; unsupported or unavailable routes refuse without
falling back to Claude. Retain the original harness and payload on uncertain
retries. Every managed worker has its own launch-local Swarm enrollment. Disconnect leaves workers alive. Managed Herdr launch
routes share Clankie's filesystem. A registered ssh fleet joins the same embedded
coordinator through `clankie swarm fleet-peer FLEET NAME --conversation ID --out
PRIVATE.json`. Transfer that private environment to the peer over the owner's ssh
and launch its matching Swarm MCP runtime with it; do not start a second coordinator
or expose the capability in a prompt. Reusing the fleet/name resumes the actor with
a new generation. `runtime list` reports `relayState`; use
`clankie herdr --connection FLEET ...` for its remote terminals. Read the CLI's
fleet-peer contract for setup and permissions. `restart-required` means the live
owner needs a deliberate upgrade. After a coordinated owner upgrade, reconnect
existing native MCP clients and verify `swarm_sync` before dispatching again.
The paired companion app exposes this inventory and named connection controls in
Settings → Connection with Supervise access. Terminal lists each connected Herdr
session and routes observation/input to its pinned runtime. Messages also lists
enrolled Swarm peers independently of terminal seats. `clankie swarm contacts`,
`swarm message PERSONA TEXT` and `swarm thread PERSONA` share those persona DMs.
A replacement generation has a new contact; never redirect an old thread by name.
`clankie swarm tasks` lists every unfinished task with its lead, owner, state and
blocker, which answers "who is working on what" without polling panes.

For coordination diagnostics, run `clankie swarm status` or `connections`.
`swarm connect PRIVATE.json` imports a dedicated externally enrolled Clankie session;
`disconnect ID` disables it without stopping its owner or moving work. Use the
CLI contract for the private file and tunnel setup. An optional `ssh: "fleet"`
uses that registered fleet to reach the remote `endpoint` (Unix socket or Windows
named pipe). Clankie supervises a private SSH relay; the project owner and its
workers stay in place. Discover the real endpoint and have the project launcher
issue a Clankie-only capability; never reuse its launcher secret or a worker
session. Every `swarm_*` call accepts
`connection: "name"`; omit for embedded. Incoming wakes name their connection.
Keep it on replies, evidence reads and retries. External grants use
`swarm.connectionId`; enrolled worker bridges set `CLANKIE_SWARM_CONNECTION`.
Load `lead` for leadership and `swarm-mcp` for this optional peer connection.
Local hires use `hire_agent` and `message_seat` without Swarm. `clankie swarm off`
disables the connection on the next captain start; `swarm on` restores it. Status
reports configured `enabled`, running `active`, and `restartRequired`. The setting
does not change the running fleet, erase Swarm state, or change the repo's tracker.
Swarm defaults on, including fresh installs. The native delivery mechanisms are
runtime adapters: Claude and Codex are implemented; Pi, OpenCode, and Prime Agent
have researched mechanisms but no local hire adapter. Skills explain these tools;
they do not implement the transports. See the agent-hosts README under `repoRoot`.
Assignments pin owner preferences and agent instructions from the selected
conversation as `contract.instructions` artifacts. Select the project conversation
before assigning; a task worktree alone does not change the instruction source.
Retry an uncertain assignment with its original ID and payload. New work takes
current preferences; an existing intent retains its snapshot. To carry installed
skills, pass `skills: ["name"]` on Clankie's `swarm_assign`; use names from the
selected conversation's composer catalog. This includes supporting files in the
snapshot, not automatic installation, execution or credentials. See the Swarm
host README for scope and limits.

For shared Linear tools, inspect `clankie access linear`; verify an API-key
or OAuth connection with `clankie access linear verify` and check the intended automation identity.
Built-in Herdr workers start through the runtime's direct argv API and already
run `clankie mcp --swarm`; they start with no
connected-service tools. Issue grants explicitly after they hold the task; tools
appear through the existing MCP connection. An external enrolled worker can use
the same command with `SWARM_SCOPE`, `SWARM_SESSION_CAPABILITY` and the selected
`CLANKIE_CONTROL_PLANE_URL`. For issuance use
`clankie access issue REQUEST.json --deliver swarm`.
Give only its non-secret grant ID/command to the worker. Configure its MCP client
with `clankie mcp --swarm-grant ID`; the bridge authenticates using the runtime's
`SWARM_SESSION_CAPABILITY` and privately retrieves that worker's existing grant.
For work outside Swarm, `--out GRANT.json` creates a private file for
`clankie mcp --grant FILE`.
Use `access list` and `access revoke ID` to inspect/revoke. Never give workers an
operator/lane bearer or put grant files in messages. `workId` is provenance;
exact `tools[].arguments` restrictions and `forbiddenArguments` enforce the
requested resource boundary. With combined create/update tools, forbid edit IDs
and alternate parent selectors for create-only access; see `docs/worker-access.md`.
For Swarm work include `swarm: { conversationId, taskId }` and set `principalId`
to the current enrolled task owner. The issuing conversation must own the task;
access ends when the attempt completes, is cancelled, expires or changes owner.
Set `renewable: true` for automatic renewal during that same active assignment.
The worker bridge persists fresh short-lived tokens; revocation still targets the
original grant ID. An expired bearer cannot renew; `--swarm-grant` can authenticate
the enrolled session again for renewable, still-active work. The owned managed host renews live task leases independently of model
turns; external hosts must renew their own attempts. Verification identifies the
connected user; it does not switch to the intended automation account. Read `docs/worker-access.md`
under `repoRoot` for the contract.
