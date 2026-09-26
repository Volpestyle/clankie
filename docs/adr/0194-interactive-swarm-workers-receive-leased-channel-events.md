# ADR 0194: Interactive Swarm workers receive leased channel events

Status: Proposed, 2026-09-26. [VUH-1380](https://linear.app/vuhlp/issue/VUH-1380).
The native channel transport has empirical evidence; the production integration
is not implemented by this ADR.

## Problem

Swarm's Herdr worker wraps `claude --print` with stream-JSON pipes. That gives the
wrapper result events and idle delivery, but the pane is an assistant-text log,
Herdr does not track an ordinary interactive turn, and workspaces display opaque
tokens. Model and effort are absent from the dispatch launch contract.

Keyboard submission is unsuitable for background delivery. Herdr's `agent prompt`
is a terminal paste plus Enter; an idle status does not prove an empty composer.
[ADR 0161](0161-a-fleet-seat-reads-its-mail-instead-of-its-keyboard.md) describes this
race, but its operator-bearer bridge and PTY fallback are not suitable for scoped
Swarm workers. This proposal has no keyboard fallback.

## Measured transport

[Probe evidence](../testing/2026-09-26-interactive-swarm-workers/README.md) uses
Claude Code 2.1.283, interactive Sonnet 5 with low effort, a single bare MCP server
and no Clankie seat credentials. A channel event starts an idle turn, preserves
an unsent draft, and queues behind a running tool. Native `UserPromptSubmit`,
`PreToolUse`, `PostToolUse` and `Stop` hooks describe those turns.

The [official channel reference](https://code.claude.com/docs/en/channels-reference)
documents bare servers as development channels. The measured version accepts
`--dangerously-load-development-channels server:swarm_probe`; a marketplace plugin
was not required. Older versions and organization policy may differ. The preview
requires an explicit local-development confirmation, which appeared in each
development-flag probe launch. A connected MCP server alone is not proof its channel is consumed.

## Startup consent and selected mode

The consent probe distinguishes an installed plugin from an approved channel:

| Launch on Claude Code 2.1.283                         | Result                                                                                          |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Bare server with development flag                     | Confirmation required; delivery works after confirmation.                                       |
| Custom marketplace-installed plugin with `--channels` | MCP connects, but channel is rejected by the approved allowlist; no reply to the emitted event. |
| Same installed custom plugin with development flag    | Development confirmation still blocks startup.                                                  |
| Official installed `fakechat` with `--channels`       | No development confirmation; idle event/reply round-trip in 1,890 ms.                           |

The [official reference](https://code.claude.com/docs/en/channels-reference)
documents confirmation for development channels. We found no documented personal
setting for persistent consent to a named development channel. The
[managed channel policy](https://code.claude.com/docs/en/channels#enterprise-controls)
provides `channelsEnabled` and `allowedChannelPlugins`; Team/Enterprise admins can
approve a specific plugin/marketplace pair. This is an administrator policy path,
not a user settings consent key. James is this Mac's administrator and can grant
that persistent approval through the documented macOS file at
`/Library/Application Support/ClaudeCode/managed-settings.json`. Local admin
control is explicitly supported by the
[deployment guide](https://code.claude.com/docs/en/managed-settings). We prepared
[exact snippets and an owner-run probe](../testing/2026-09-26-interactive-swarm-workers/managed-consent.md),
but did not apply policy or empirically test it on this personal Max account. `clankie seat` itself passes the development
flag; its settings enable the plugin and command permissions, not persistent
channel consent.

The [official 2.1.x changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
records channels in 2.1.80, the managed allowlist in 2.1.84, fail-closed handling of
unreadable policy in 2.1.267, and matching the installed plugin's name as well as
marketplace in 2.1.281. Do not borrow an approved plugin's identity for Swarm.
The successful official demo is a positive control, not a Swarm deployment path.

Therefore expose **explicit owner-selected `interactive` and `stream` modes** in
runtime settings, API, CLI and TUI. Until Swarm's actual distribution has a verified
unattended channel startup path, keep `stream` as the advertised unattended
selection. Select `interactive` when a human is present to confirm development
startup. Resolve and display the mode before dispatch; store it in the immutable
intent and launch receipt. Do not infer human presence from a focused pane.
An interactive startup that blocks or times out stays visibly blocked in that
mode; it must never switch to stream automatically. An owner may explicitly
choose stream for a subsequent dispatch after the existing attempt is reconciled.

Owner-managed approval of the exact installed worker plugin is the **preferred
unattended interactive path if the prepared probe passes**. The proposed worker
identity is `clankie-worker@clankie`, separate from the operator-seat plugin; it
is not implemented yet. First prove persistent consent with two fresh sessions
of the isolated custom-plugin fixture, then repeat readiness against the actual
worker package. The policy must also preserve the operator seat: verify actual
wake, watch and Swarm channel receipts after policy adoption and a coordinated
fresh seat launch. If the development flag does not preserve delivery by itself,
the owner must explicitly allow `clankie@clankie` and repeat the checks. Preserve
any official channels the owner uses; the managed list replaces the default list. Stream remains the default until the owner explicitly opts in
and the production worker passes capability/lifecycle tests. Do not install or
edit managed policy as an implicit side effect of dispatch or runtime settings.
Normal workspace trust or tool permissions can still block either interactive
launch path; approved channel status is not universal unattended readiness.

## Proposed implementation

1. For selected `interactive` mode, keep the Herdr wrapper as the owner of the launch token and task-heartbeat
   timer. Launch Claude with inherited terminal stdio, without `--print` or
   stream-JSON flags. Preserve the stored selected cwd, worker enrollment and
   existing receipts. The wrapper must not treat interactive Ctrl+C as a request
   to kill the whole worker; terminal cancellation and supervisor termination
   need separate handling.
2. Add a channel mode to the existing Swarm MCP projection, using only the
   worker's enrolled `SWARM_SESSION_CAPABILITY` and pinned coordinator endpoint.
   It must never read the operator broker or load the operator-seat plugin.
   Serve Swarm tools and channel events through one scoped process; the preview
   server declaration and flag belong in the trusted launch record.
3. Use the existing inbox observer and `RuntimeDelivery` leases. Fetch only after
   channel readiness is established, with one outstanding envelope per worker.
   Native hooks publish busy/available observations; `Stop` kicks deferred reads.
   Known-busy sessions defer fetch. A notification racing a new native turn safely
   queues inside Claude, as the probe demonstrates. Transport write success is
   not an acknowledgement, task completion or proof of model processing.
4. Channel-enabled workers must have one inbox consumer. Their native hooks
   publish lifecycle state instead of independently fetching additional context.
   The current `UserPromptSubmit`/`PostToolUse` fetch path remains for standalone
   hook-only workers; leaving both consumers enabled would create competing
   admission paths. The wrapper renews task leases throughout model/tool activity,
   independently of channel reconnects or turn duration.
5. Preserve `message_id` across retries. The envelope carries its current
   `leaseToken`, expiry and attempt. A processed receipt is keyed by actor/scope
   and message ID; the token fences the current acknowledgement only. An expired
   token never authorizes an ack. Redelivery of completed work reuses its result
   and acknowledges the fresh token. A merely presented or uncertain operation
   must be reconciled, not marked completed or automatically repeated.
6. Record requested model/effort and resolved owner defaults before any launch side effect. Proposed
   assignment shape: `execution: { mode?: "interactive" | "stream", model?: string, effort?: "low" | "medium" |
"high" | "xhigh" | "max" }`, valid only for a compatible Claude route.
   Include supplied selection in the immutable intent fingerprint and copy the
   selection passed to Claude into the launch record. Pass values as argv, never shell
   interpolation. Validate shape and known native effort levels before provisioning;
   surface model availability failures during startup without substitution. Capture
   the native reported model separately so an alias is not presented as a concrete
   resolved model. Retries retain the original selection. Expose the same owner defaults through
   Clankie's runtime API, CLI and TUI. Unspecified values remain distinguishable
   from explicit choices; the coordinator must not silently switch harnesses.
7. Label the workspace, tab and Claude session from the bounded task title;
   retain task/token identity in metadata and receipts rather than replacing the
   title with a random token. Labels are display text, never selectors or authority.

## Readiness and recovery

A private channel round-trip nonce, tied to the launch token and native session,
should prove the channel listener is active before new task envelopes are fetched.
MCP initialization, a pane existing, or the `started` receipt alone cannot prove
this. The probe even displayed a misleading “no MCP server configured” warning
while delivery worked. Readiness needs affirmative evidence and a bounded timeout.

Development-channel confirmation remains a real launch constraint. The worker
must expose blocked startup and preserve its existing token while the owner
handles it; do not auto-accept arbitrary permission dialogs, inject prompts, or
silently substitute stream mode. The selected stream mode retains the existing
stream-JSON worker path. Validate the actual approved distribution and startup
path before declaring unattended interactive dispatch supported. If readiness is
uncertain, retain the receipt and reconcile the same worker rather than launch
another one. Organization policy failures are explicit unsupported states.

### Dispatch success requires worker readiness and ownership

The [startup incident evidence](../testing/2026-09-26-interactive-swarm-workers/startup-incident.md)
shows four new workers with no Swarm tool calls, despite reported binding. The
current provider accepts a persisted `started` flag plus `available`/`busy` session
observation; `DispatchTransaction.bind` then claims the task on the worker's
behalf. That sequence proves neither MCP usability nor worker acceptance.

For both stream and interactive dispatch, **do not return `bound` or successful
`started` until the worker's own authenticated readiness round-trip succeeds and
its task claim is verified**. Require the actual harness-to-MCP path, compatibility
with the selected owner build, and a receipt fenced to intent, provisioning token,
actor, native session, enrollment generation, task, attempt and fence. Interactive
mode additionally requires its channel round-trip. The wrapper's independent
coordinator client must not manufacture this proof from its own connectivity.

Represent physical launch separately as `starting`/`awaiting_worker_ready`;
retain the existing launch receipt as physical evidence, never success evidence.
Use a bounded startup challenge/control exchange before admitting ordinary task
mail. Refactor the current coordinator-side bind/claim sequence into a fenced
worker-readiness/claim commit, so waiting for readiness does not depend on an
assignment delivered only after `bound`. Commit claim and ready binding atomically
or reconcile their persisted intermediate state; do not claim a second attempt
on a lost response. Returning success requires reading back that same claim.

Return typed startup failures such as `worker_mcp_disconnected`,
`coordinator_version_mismatch`, `worker_readiness_timeout`, or
`worker_claim_failed`, with retry/reconciliation guidance and retained intent,
launch and task identifiers. A timeout does not prove the process stopped. Keep
uncertain launch/capacity reservations until positively reconciled; do not auto
redispatch, report cancellation success, or release ownership from a pane close.
Extend the MCP output schema, CLI and TUI together so the typed failure reaches
the lead without being reduced to a successful pane launch.

### Independent worker health and lead progress alarms

The supervisor needs an authenticated health channel from the worker MCP process,
separate from model-written text: initial registration, disconnect/exit reason,
and bounded liveness probes. Claude owns the MCP child today, so the wrapper
cannot simply assume it receives that child's process-exit event. Add an explicit
local bridge/supervision seam and retain sanitized child stderr/exit metadata.
For interactive workers, a long model/tool turn must not prevent this health
reporting. Successful wrapper IPC is not successful MCP health.

On confirmed MCP loss, the wrapper reports **`blocked:mcp_disconnected` through
its own still-working coordinator client**, fenced to the current launch/session
and task attempt. Stop new inbox admission/redelivery into the broken harness;
leave messages unacknowledged. Do not mark a Claude `result` as available while
MCP health is failed or unknown. Preserve task fencing and bounded recovery;
health failure is not task completion or permission for another worker to act.
If wrapper IPC also fails, retain a private local diagnostic and let coordinator
liveness expiry expose lost supervision; never fake a delivered blocker.

Persist and deliver a deduplicated blocker/health event to the requester and lead
status surfaces independently of the worker's MCP. Add a coordinator-side stale
progress alarm using the existing task attempt's `progress_at` and
`progress_timeout_ms` deadline, not an undifferentiated session `updatedAt`.
Heartbeat renewal, token streaming and assignment redelivery must not reset
meaningful progress. Alarm thresholds should be owner-visible/configurable and
available via API, CLI and TUI. Distinguish slow work from proven disconnect,
include last progress/health/renewal times and attempt identity, and resolve the
alarm only on real progress, recovery or terminal outcome. Coordinator status
must retain the alarm even when the lead's own channel is unavailable. Existing
progress/lease expiry remains authoritative; the alarm is not automatic reassignment.

### Runtime upgrades must preserve running generations

Before replacing a runtime artifact or its installed dependency graph, discover
all affected coordinator scopes, live dispatches and uncertain reservations.
Refuse an in-place install while those workers may still execute; report their
IDs, runtime paths and build digests with the coordinated drain/restart action.
Unavailable inventory is not evidence of an empty fleet. Apply this preflight to
checkout `pnpm install`/re-vendor and release installation, not only service restart.
Coordinate an admission pause/upgrade lock with dispatch so new workers cannot
race between the check and replacement. Any owner override must be explicit and
retain the unresolved work list; it cannot claim a safe upgrade.

Prefer immutable, content-addressed runtime generations, including dependencies,
skill and hook executables, pinned in each launch receipt. Keep generations while
referenced by a live owner, worker or uncertain receipt. Pin the MCP executable
and fresh hook subprocesses as well as the already-running wrapper. Installing a
new generation must not mutate those paths. New dispatch must verify the owner
and worker candidate's API/schema/skill/build compatibility **before** provisioning;
do not point new workers at a new build while their owner remains on the old one.
An immutable worker directory alone does not solve mixed-version dispatch.

These safeguards are proposed, not implemented. Until they ship, the vendor
procedure requires a coordinated dispatch hold, reconciliation/drain, fresh
online database backups and an explicit owner/service restart window before
installing a changed runtime into the service checkout.

An interrupted transport does not acknowledge a message. Existing retry backoff
and lease expiry recover it. Reconnect authenticates the same fenced enrollment;
revoked credentials never trigger reenrollment. Native session resume, wrapper
failure and fresh channel readiness require integration coverage before rollout.

## Effect idempotency is narrower than delivery

The probe commits one durable file with exclusive creation, deliberately loses
its ack, then reuses that effect on a new lease. This proves the protocol supports
idempotent processing. It does not make arbitrary shell commands, repository
edits or external writes exactly once. Those effects need their own transactional
idempotency key or receipt reconciliation. Transcript presence proves context
admission, not completed effects. Do not use `(message_id, leaseToken)` as the
processing key: the new token would allow the same effect again.

## Implementation acceptance still open

- Real interactive worker shows Herdr working/idle transitions, preserves an
  operator draft and receives a reply after a long tool without terminal writes.
- Real task ownership, heartbeat renewal, cancellation, native resume, channel
  reconnect and fenced-session rejection survive the new launch arrangement.
- Worker-only capability, no seat/operator bearer, one inbox consumer, and
  reconnect/expiry tests prove no duplicate controlled effect or false ack.
- Model/effort are validated, fingerprinted, visible in status and retained across
  retries; task titles appear on workspace/tab/session surfaces.
- Selected mode is visible before dispatch and persists in status/receipts;
  interactive startup never silently changes to stream. Approved-distribution
  readiness and human-confirmed development startup are tested separately.
- Version/policy/startup failures are actionable without duplicate dispatch or
  silent transport fallback. The broader MCP-profile UI remains a later lane.

Additional incident acceptance:

- A worker MCP that exits before readiness produces a typed failed/pending startup,
  never `bound`; an authenticated MCP path plus verified task claim is required.
- Kill only an owned test MCP after binding: the surviving wrapper reports
  `blocked:mcp_disconnected`, stops repeated admission, and the lead sees the alarm.
- Keep renewing a stalled test attempt: it still raises the progress alarm without
  extending progress deadlines; no false completion or duplicate reassignment.
- Re-vendor/install with a live or uncertain test worker is refused before files
  change; an admission race is fenced. A pinned old generation continues to run
  while a new generation is staged, and mismatched new dispatch fails before launch.
- Lost readiness/claim replies and uncertain cancellation preserve receipts and
  fences; recovery reconciles the same attempt rather than launching another one.
