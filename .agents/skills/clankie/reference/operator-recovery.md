# Operator recovery

Detail for [Working beside Clankie](../SKILL.md). These routes need the
installed service's operator access or a lead's hire tools; a worker plugin does
not confer them. A worker that meets one of these states reports it to its lead.

## Hire receipts

A `No durable native binding` receipt
means no new message was sent; report the pane and inspect its native binding.
Managed PC Codex hires set their assigned worker name on the fresh native thread
before briefing it. A native naming refusal prevents the brief; inspect the
original hire receipt and do not replay it. Resumed sessions keep their names.
Fresh-root bootstrap uses the metadata confirmed after naming, because an
unnamed root's read reports a synthesized read-time creation timestamp. That
time must still belong to the exact fresh view's startup window;
saved/forked history errors and post-dispatch uncertainty never authorize replay.

With authorized operator access, `clankie hire-receipt settle ORIGINAL_ID
abandoned-unknown` records an explicit decision to abandon an unmapped fresh
remote Codex launch and permit separately new intent. It requires the original
authenticated launch journal and fresh census; allocation fate stays unknown.
The original is never retried. It grants no pane ownership, close or adoption
authority. Known allocations use the ordinary recovery disposition instead.

The operator's `settle_hire_receipt` tool can settle any retained fresh hire;
delegated project leads and room tools can settle only their owning conversation's
fresh hires. Project allocation UUIDs use `release-allocation`, not
`abandoned-unknown`: complete native inventory must prove the original pane and
directory absent, with no unresolved native receipt. That release preserves launch
history and sends nothing. A completed successful remote hire whose pane was
closed or harvested permits separately new `freshIntent` work after a complete
census on its original configured host. Use the latest native receipt or fresh
intent UUID in `afterReceiptId`; refusals name the expected identity. Keep a new
brief and intent UUID, never replay an uncertain dispatch or edit a live journal.

## Refreshing worker tools

The bridge observes schemas and authenticated runtime revisions every five
seconds. Deploys schedule local managed Codex refresh through its original
controller, private config version and loaded root/descendant inventory, at
idle. The operator can request one or its own led/hired seats with `refresh_worker_tools`,
`clankie harness refresh-tools [--pane PANE]`, or TUI `/refresh-tools`.
No pane selects only the calling conversation's led/hired seats, including remote seats. Other panes return `skipped-not-owned` and require an explicit pane through the authenticated owner API/CLI. Ownership is rechecked before deferred effects.
Read each `refreshed`, `catalog-refreshed`, `skipped-busy`, `skipped-not-owned`, or `failed` result.
A Claude seat still on an older plugin fails with `original_claude_plugin_unchanged`:
the catalog refresh reaches its running bridge, but a plugin loads only when its
session starts. Its `detail` names that step: between tasks, close the pane and
call `hire_agent` with `resume` set to its transcript ref.
For hired remote Codex seats, retain the report and settle original receipts,
then require `closed` before resuming `FLEET:SESSION_ID` in the same harness,
fleet and workingDirectory. Clean unlanded commits may remain only with an
explicit `unlandedReason`; dirty or unknown work evidence still refuses.
`undo_worker_pane` within five minutes performs the same guarded resume and
checks for an already-open thread first. A refusal keeps the worker intact.
An uncertain close or resume keeps its original history/receipt: inspect it,
never blindly retry the launch or create a fresh replacement.
Local Codex `catalog-refreshed` proves the original connected MCP catalog,
not next-turn model exposure or report delivery. Check `clankie_tools` in that
same thread and send one new `message_clankie` report; keep its stored receipt.
Result `detail` shows the native runtime failure, loaded scope, or verification gap.
A confirmed reload that reached failed MCP startup can receive a fresh guarded
transport revision on its original thread. Unknown catalog evidence and lost
mutation acknowledgments still require read-only reconciliation; never replay
them. Independent loaded roots remain a safe refusal, with their inventory in
`detail`; a startup observation may become obsolete, so inspect again at idle.
Roster/doctor versions and runtime-behind fields are observations, not tool authority. Codex
does not refresh a loaded thread's catalog on MCP list-change notifications, and
a fresh observer connection does not refresh the original thread; the
controller's transport revision is the refresh path.
For manual or remote clients, report the stale catalog and ask the owner to
reconnect the exact thread with its original cwd, account home and flags after
its runtime unloads. Never restart a shared daemon, fork automatically, or
replay an uncertain tool call. Controller-owned hires need controller recovery.

## Older bridges

Runtime and on-disk plugin updates do not replace an already-imported worker
receipt parser. Supported local controllers refresh that MCP connection on the
same thread. A local Codex seat whose roster row shows `restart needed` follows
that row's remediation: automatic legacy restart is disabled, so the lead closes
it when idle after retaining its handoff and settling original receipts, then
hires a fresh worker; original thread evidence stays on disk. A refreshed supported bridge reads the retained original
once after active calls settle; it sends no replacement.
An unresolved original stays held. A separate deliberate call after settlement
sends the later report. Remote Codex controller/config recovery and replacing
old imported Claude bridge code remain explicit verification gaps. Remote Claude
refresh defers while busy, then reports
`original_remote_claude_imported_bridge_refresh_unsupported` without a refresh
signal. A healthy root report or newer installed cache is not proof of imported
code or every descendant's adoption. Preserve the original session and receipts;
Portal access permits no worker hire or configuration write. Never
delete the claim or report a sealed negative as a positive stored delivery.

## Conversations and finished files

With authorized operator CLI access, `clankie conversations list` identifies
threads; `clankie conversations show ID --limit 10` reads the selected thread.
Confirm the destination before writing. Discord conversation records are
read-only views; sending to an operator thread does not post in Discord.

For an authorized operator-thread message:

```sh
clankie send --conversation ID --stdin < message.txt
clankie send --conversation ID --delivery queue --stdin < follow-up.txt
```

Default delivery steers an active Pi turn at its next input boundary; `queue`
requests a separate turn. Either can start a turn when idle. The returned receipt
is admission, not the answer. Read that same conversation to verify the result;
inspect conflicts or uncertain delivery before resubmitting.

`send --conversation ID --attach IMAGE_OR_VIDEO_PATH` adds supported media.
For a finished file, authorized operator access can use
`clankie file publish --conversation ID PATH`. The file must be inside that
conversation's real working directory, at most 15 MiB. Its artifact receipt
means published to that conversation, not sent to Discord or uploaded to Linear.
A remote filesystem path is not a local publishable path.

## Sessions and machines

`clankie agents list --host HOST --limit 5` returns native transcript references
and per-host errors. `clankie agents read HOST:SESSION --tail 20` reads a bounded
page; use its cursor with `--after` for later additions. Recent transcript activity
does not prove the process is alive or controlled. Resolve the exact session
before a requested resume: resuming can launch or address a native agent and is
not read-only. Reconcile an uncertain start or send instead of launching twice.

Windows Codex sends rediscover the backend from the visible TUI's native
`--remote` endpoint and its kernel listener, including detached hired servers
after service restart. Re-adoption never restores cached launch authority.
If that listener is gone, re-adoption cannot recreate it: ask the owner to
end the stale TUI, then resume the exact saved session with `hire_agent`'s
`resume` reference and a new dedicated backend. Do not restart or replace the existing pane as a probe.

## Operator bridge binding refusals

An unbound `clankie mcp --lane operator` cannot inherit `global-default`, read,
poll or acknowledge reports, or message seats. Start it through the normal
`clankie claude|codex|opencode|grok` launcher. The service verifies the socket
owner, launcher→harness child edge, process lifetimes, selected conversation
and bridge-only nonce. Do not copy the nonce into harness env/argv or rebind a
foreign PID. `clankie doctor` exposes native helper availability and the last
precise refusal/recovery; a historical refusal stays in the report body and
cannot replace a live doctor finding. Normal missing-registration startup
retries are not retained as diagnostics. A successful registration/admission
clears the recorded refusal for that conversation. The bridge retries only
missing or stale registration within its bounded startup window; wrong ancestry,
nonce, conflict or an existing claimant remain final.
Missing helper, unprovable socket, wrong ancestry, wrong claim and another live
claimant are distinct refusals. Prime's missing verified kernel PID remains open.
Joined/delegated seats retain their separate authenticated route; relay/app
owner dispatch is separate from local MCP. The
[seat binding reference](../../../../integrations/claude-plugin/README.md#binding-and-the-known-unbound-bridge-gap)
records process-chain limits and recovery of reports already consumed by a stray.
Never replay an acknowledged report or uncertain delivery to compensate.
