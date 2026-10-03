# Clankie in OpenCode

`clankie seat --harness opencode --conversation ID --dry-run` reviews a launch.
Remove `--dry-run` to open the native interactive TUI. `--resume` reopens only
the recorded native session and conversation. A fresh launch creates its own
workspace chat; `--conversation ID` selects an existing chat, and `--dry-run`
creates nothing. Older resume records without a conversation retain the global
chat. The service resolves the workspace before launch; a changed resume
workspace fails closed. `/seat opencode` in Clankie's
console reviews the same plan. Requires the running Clankie service, a brokered
operator credential, OpenCode 1.18.x, and `clankie` on PATH. Capability discovery
checks the installed version and native session/server flags before launching.
`CLANKIE_OPENCODE_BIN` can select an absolute native binary.

The exported `planOpenCodeSeat` and `runOpenCodeSeat` functions provide the local
launch API. This change does not add a remote HTTP terminal-launch endpoint.
Service integration uses the existing operator seat-context, prompt, memory,
MCP, outbox and transcript HTTP APIs. Native OpenCode workers remain separate
(VUH-1555); `runtime.mjs` is the reusable same-session delivery boundary.

## Install, settings and removal

The plugin ships with Clankie; no global OpenCode plugin install is required.
The launcher adds its file URL and the selected bundled skills to
`OPENCODE_CONFIG_CONTENT`. Existing inline settings and unrelated MCP servers
remain. The plugin replaces the `clankie` MCP entry with
`clankie mcp --lane operator` and disables inherited Linear-named/Linear-hosted
MCP connectors for this launch, so tracker work uses Clankie's connected account.
The native permission settings are unchanged. The launcher sets
`autoupdate:false` for its own process. `/skills` controls the shared bundled
skill selection. Neither installation nor launch edits owner configuration.

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

Before dispatch the launcher writes an `uncertain` receipt atomically to its
per-launch journal. This fences duplicate claims within that launcher, including
plugin reconnects; a new random launch directory does not load earlier receipts
and is not a cross-launch deduplication fence. A native
acknowledgment changes it to `delivered`, which means accepted, not completed.
A failed or lost acknowledgment stops delivery without retry, fallback typing,
or another process launch. Inspect the native session and retained receipt
before deciding whether a manual resend is appropriate. Pending queue entries
are retained for inspection, not automatically replayed on restart. A new
launcher always requires a fresh native binding; no restart reattachment is
claimed from a saved ID alone. The current service pump acknowledges an event
on its next poll after the launcher persisted it, potentially before native
dispatch. That bridge acknowledgment is not evidence of native consumption, and
a crash can strand a journaled event. No exactly-once guarantee across launcher
or service restarts is claimed; persistent receipts are separate VUH-1521 work.

Missing binary/capability, absent broker credential, changed resume workspace,
wrong conversation, plugin context failure, disconnected bridge, duplicate
claim and mismatched session all fail explicitly. Native transcript sync errors
are reported through native toasts and the launch journal, and retained native
records retry at later events. They do not
remove the loaded memory card. The service must support OpenCode `ses_*` upload
IDs; an older service rejects projection. Never restart a shared service merely
to complete an acceptance probe.

## Verification status

Deterministic tests cover native busy/idle behavior, identity mismatch,
claim-before-dispatch and uncertain delivery, role boundaries, bridge auth,
config preservation, exact resume, preflight-before-ready ordering, context
failure and identity mismatch without extra turns. Scoped native evidence and remaining
acceptance gaps are recorded in
[the verification notes](../../docs/testing/2026-10-03-opencode-seat/README.md).
Native draft preservation and pending approval behavior were checked in an
owned scratch TUI. The complete production outbox/projection cycle remains
unverified; unit tests do not substitute for that acceptance.

Native references: [plugins](https://opencode.ai/docs/plugins/),
[server](https://opencode.ai/docs/server/),
[configuration](https://opencode.ai/docs/config/).
