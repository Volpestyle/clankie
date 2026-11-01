# Clankie in OpenCode

`clankie opencode --conversation ID --dry-run` reviews a launch.
Remove `--dry-run` to open the native interactive TUI. `--resume` reopens only
the recorded native session and conversation. A fresh launch takes the global
chat while no live seat holds it, else (or with `--new`) creates its own workspace
chat; `--conversation ID` selects an existing chat, and `--dry-run`
creates nothing. Older resume records without a conversation retain the global
chat. The service resolves the workspace before launch; a changed resume
workspace fails closed. `/opencode` in Clankie's
console reviews the same plan. Requires the running Clankie service, a brokered
operator credential, OpenCode 1.18.0 or newer, and `clankie` on PATH. Capability
discovery checks the installed version and native session/server flags before
launching, and names a missing flag.
`CLANKIE_OPENCODE_BIN` can select an absolute native binary.

The exported `planOpenCodeSeat` and `runOpenCodeSeat` functions provide the local
launch API. This change does not add a remote HTTP terminal-launch endpoint.
Service integration uses the existing operator seat-context, prompt, memory,
MCP, outbox and transcript HTTP APIs. Native OpenCode workers use a separate
control binding (VUH-1555); shared transcript projection does not share operator
authority.

## Install, settings and removal

The plugin ships with Clankie; no global OpenCode plugin install is required.
The launcher adds its file URL and the shipped skills to
`OPENCODE_CONFIG_CONTENT`. Existing inline settings and unrelated MCP servers
remain. The plugin replaces the `clankie` MCP entry with
`clankie mcp --lane operator` and disables inherited Linear-named/Linear-hosted
MCP connectors for this launch, so tracker work uses Clankie's connected account.
The native permission settings are unchanged. The launcher sets
`autoupdate:false` for its own process. `/skills` lists the shipped skills.
Neither installation nor launch edits owner configuration.

Identity and the current operator memory card are loaded from the service in
`experimental.chat.system.transform`, before each model request. The native
plugin's `config`, `chat.message` and session/message events establish identity
and projection. OpenCode's own workspace and owner skills still apply.
The launcher resolves its operator bearer from the broker; it never places it
in the native process environment, plugin, launch plan or local bridge journal.
The plugin receives only a per-launch loopback bridge token. MCP independently
uses the existing broker-backed operator bridge; no account credentials move.

Exit the native TUI to stop the seat. Nothing remains globally enabled, so no
OpenCode uninstall/config cleanup is needed. Removing the bundled Clankie plugin
files removes support; do not run `opencode uninstall`. Resume metadata and
receipt journals live under the Clankie state directory in `opencode-seat.json`
and `opencode-seat-launches/`. Preserve uncertain receipts until reconciled.

## Delivery and failures

Delivery starts only after the bound session has loaded its operator context.
An exact resumed session is verified with the injected SDK and preflights the
service context during plugin startup. A newly created root session performs
the same read-only preflight on its native creation/binding event. Neither
requires an owner prompt or bootstrap model turn. An uncreated session cannot
bind wakes; the plugin never creates or guesses one. Every real model request,
including a native wake, still loads fresh identity and memory in the system hook.
Resuming uses the exact `--session`
ID; it never uses `--continue`. The plugin calls its injected native SDK client,
not a guessed server URL or a separately started server. Idle dispatch uses
`session.promptAsync`; busy sessions wait. This does not claim active-turn
steering. Owner drafts are untouched: no prompt append/submit endpoint or
terminal input is used. Native approvals remain owner decisions.

A new root session or a prompt in another session disables the binding. An
unsubmitted navigation to an existing session is not proven detectable by the
server plugin; delivery remains pinned to the original ID and never follows UI
focus. Do not use session switching as a way to transfer the seat. Exit and
launch the selected exact session instead.

Before dispatch the launcher exclusively creates a binding-scoped unresolved
receipt under `opencode-seat-receipts/`, in addition to its per-launch audit
journal. This fences every retry, including another launcher. Native queue
acceptance changes the audit outcome to `delivered` with `deliveryStage:
consumed`; it does not prove model attention or task completion. A lost receipt
blocks dispatch until exact-session native history contains the complete
original event, including its ID, or the original native acceptance arrives.
A new session cannot reconcile an old session's event. A corrupt receipt fails
closed. This read-only reconciliation never launches a replacement turn.

The service bridge explicitly acknowledges the event ID after the launcher
persists its pending event. That receipt is `delivered`, not `consumed`, and may
precede native dispatch. Pending events retained only in a launch journal are
inspection evidence and are not automatically replayed after restart. No
exactly-once work completion guarantee is claimed. A new launcher still needs
fresh native identity and context preflight; a saved ID alone never arms it.

Missing binary/capability, absent broker credential, changed resume workspace,
wrong conversation, disconnected bridge, duplicate claim, mismatched session,
a deleted session and uncertain delivery all stop the seat explicitly.

**Context reads.** A slow or failed read of Clankie's identity and memory card is
retried three times with a short backoff. If every attempt fails, only that turn
fails, with a native toast and a `context_unavailable` warning in the launch
journal. Queued service events wait until context loads again, rather than
entering a turn without it. The plugin keeps retrying in the background, so
delivery resumes without an owner prompt.

**Model errors.** A provider error (`session.error`, such as an invalid key or an
unavailable model) also fails only its turn. It is recorded as a
`turn_failed: …` warning, and later turns still deliver.

**First stop cause.** The launch journal's `failure` and the close line keep the
first cause that stopped the seat. A later refusal, including the bridge's own
409 to a follow-on poll, never replaces it. Native transcript sync errors
are reported through native toasts and the launch journal, and retained native
records retry at later events. They do not
remove the loaded memory card. The service must support OpenCode `ses_*` upload
IDs; an older service rejects projection. Never restart a shared service merely
to complete an acceptance probe.

## Verification status

Deterministic tests cover native busy/idle behavior, identity mismatch,
claim-before-dispatch and uncertain delivery, role boundaries, bridge auth,
config preservation, exact resume, preflight-before-ready ordering, context
failure and identity mismatch without extra turns.
`opencode-seat-resilience.integration.test.ts` runs the installed OpenCode (1.18
or newer; last run on 1.19.3) server with this plugin, the real seat bridge and an in-process Clankie service;
only the model provider is a fixture. It covers a stalled context read, a turn
ending in a provider error followed by a delivered app turn, and a preserved
first stop cause ([evidence](../../docs/testing/2026-10-17-opencode-seat-resilience/README.md)). Scoped native evidence and remaining
acceptance gaps are recorded in
[the verification notes](../../docs/testing/2026-10-03-opencode-seat/README.md).
Native draft preservation and pending approval behavior were checked in an
owned scratch TUI. The complete production outbox/projection cycle remains
unverified; unit tests do not substitute for that acceptance.

Native references: [plugins](https://opencode.ai/docs/plugins/),
[server](https://opencode.ai/docs/server/),
[configuration](https://opencode.ai/docs/config/).

## Hired native workers

`worker-tui.mjs` is a separately loaded native TUI plugin. Local macOS workers
require a direct OpenCode executable at **1.18.18** or newer and a
controller-created initial argv pane in Herdr. On load the plugin probes every TUI
and SDK call a worker makes; a missing one answers initialization with
`OpenCode VERSION lacks the Clankie worker surface: …` and creates no session. The controller verifies the original process, socket, cwd
and session; the plugin observes that TUI's displayed route and uses its SDKv2
client. It leaves prompt drafts, permissions and questions with the owner.
`worker-server.mjs` selects `clankie mcp --fleet`, without an operator token.
Inherited personal Linear connectors are disabled for this worker launch;
owner configuration and native permissions are preserved.

Only the first awaited TUI initializer may create and navigate to a fresh native
session, before the native prompt mounts. Delivery names the exact session and
message. Native queue acceptance is a receipt, not model attention or completion;
completion requires the matching finished native reply. Route changes, lost
control and uncertain sends never trigger another launch or resend. Native
interrupt targets only the bound session.

`clankie harness refresh-tools [--pane PANE]` uses that same original controller
to observe the existing `clankie` MCP connection. The service publishes its
catalog revision while idle, and OpenCode's native `tools/list_changed` handler
reads definitions through the existing client. Refresh never calls native
`mcp.connect` or closes a transport: the pinned reconnect replaces the client
without an atomic activity guard and could interrupt a call beginning during
the request. The service requires an actual bridge `tools/list` observation at
the requested revision as well as the native SDK's connected status.
Running sessions (including background native sessions), owner decisions and
concurrent controller actions skip refresh. Process, account, session route and
fleet admission remain fenced before observation and after the native response.
An original native event observer holds refresh when a child becomes busy or
an owner decision appears during awaited admission, even if that activity ends
before the admission returns. Missing activity observation refuses refresh.
The operation preserves the displayed session, draft and in-flight calls and
submits no model turn. Native connected acceptance is recorded separately from exact
model-visible tool names, which OpenCode's public TUI SDK does not expose.

Registered dedicated worker SQLite history is available through
`clankie agents list` and `clankie agents read`. It is bounded stored v1 content,
not proof of the currently displayed session or control.
`clankie agents resume … --conversation ID` requires the original live controller
and fresh identity/cwd checks, even without a brief. General profile discovery,
restart reattachment and new-process resume remain unavailable.

Linked Mac POSIX workers use the same plugin and controller over a private
loopback SSH forward. The service stages its own helper/plugin files in an owned
private remote directory, proves both socket ends and checks the native process
and Herdr allocation afresh. The helper reuses Clankie's registered SQLite reader;
provider secrets and owner-wide profiles do not cross the link. Remote history
uses `<fleet>:ses_…`; live reuse never creates another writer. Node 24+, Python 3,
Herdr, native 1.18.18 or newer and the existing Clankie fleet link are required
there.
Windows is unsupported. Remote fixture coverage is not a live acceptance claim.

An owned live worker can exit through its original TUI's `app.exit` command;
success requires its original terminal to disappear. Cold, replaced or switched
sessions refuse this control. There is no unconditional physical pane-close
fallback. See the
[worker evidence and limits](../../docs/testing/2026-10-04-opencode-workers/README.md)
for the original deterministic checkpoint, later native persona/exit evidence
and the live checks still open; those stages are separate.

## OpenCode 2 workers

OpenCode 2 does not run V1 plugins, so a hire on an installed 2.x release
(`opencode --version` prints `opencode v2.x.y`; floor **2.2.5**) takes the V2
plugin under `v2/` instead, selected by the probed version. V1 installs keep
the files above. See [ADR 0333](../../docs/adr/0333-opencode-2-hires-run-a-private-server.md).

- `v2/worker-tui/tui.mjs` is the TUI part (default `{ id, setup }`), passed per
  launch in `OPENCODE_CLI_CONFIG_CONTENT` with the controller's endpoint and
  token. It joins the same WebSocket controller protocol as the V1 worker.
- `v2/worker-server/index.mjs` is the server part, passed in
  `OPENCODE_CONFIG_CONTENT`. Through `ctx.mcp.transform` it sets
  `clankie mcp --fleet` and disables inherited personal tracker servers.
- `v2/worker-runtime.mjs` holds the logic both parts share.

The launch copies `v2/` into the per-launch directory, so editing the checkout
cannot hot-reload a running worker. The TUI starts as
`opencode --standalone <cwd>`: its server is a private child whose lease ends
with the TUI, not the owner's shared background service. The owner's database
is used as is, because OpenCode 2 keeps provider credentials there; there is no
dedicated profile and no registered SQLite history for V2 hires.

Setup creates the session at the hire's directory (with the hire's model, as
OpenCode 2 has no `--model` flag) and navigates to it before the TUI mounts a
prompt. Each message is admitted with `session.prompt` and an explicit
`delivery` of `steer` (the next step of the running turn) or `queue` (after
it), under a client message id; OpenCode returns the inbox item, which is the
receipt. Pending permissions or forms report `blocked` and hold sends. A
turn settles at OpenCode's idle marker after the message. Interrupt calls
`session.interrupt` for the bound session; exit dispatches the TUI's own
`app.exit`. Linked Macs on OpenCode 2 refuse by name.

`apps/clankie/test/opencode2-worker.integration.test.ts` runs the installed
OpenCode 2 TUI in a display-only pseudo-terminal (nothing is typed into it)
with this plugin, the real controller and adapter, and a fixture model
provider. It skips when `opencode` on `PATH` is not 2.2.5 or newer.
