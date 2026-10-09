# ADR 0259: Remote project leads use seat-bound delegation

Status: accepted and implemented, 2026-10-09; VUH-1927 head startup and a live bridge tool call verified on the PC.
Tracked by [VUH-1927](https://linear.app/vuhlp/issue/VUH-1927).
Extends [ADR 0218](0218-native-seats-drive-their-attached-conversation.md)
and [ADR 0244](0244-machines-join-clankie-at-an-access-level.md).

## Decision

A project lead is Clankie's named project conversation, with a native harness
head on an owner-linked machine. The service projects a standalone operator
plugin and launches that head in a fresh Herdr pane through the existing fleet
transport. The remote machine needs its harness and Node, not a Clankie install.
Existing workers and their panes are not converted implicitly.

The head uses an existing signed-in native Claude.ai profile on that machine,
never a fresh profile or copied credentials. Launch selects an explicit PC
`CLAUDE_CONFIG_DIR`, or the unique signed-in profile discovered there. Native
setup installs the versioned lead plugin into that profile and approves its
own channel additively in managed policy before allocating a pane. Disabled
channel policy, missing sign-in, ambiguity or an unwritable administrator
policy refuses setup with a diagnostic. The native install remains disabled
for ordinary sessions. Repeated preparation accepts only the native CLI's exact
user-scope `already_in_goal_state` disable receipt and verifies the installed
plugin is disabled afterward; other native failures still refuse. A previous
head's session-only activation does not require closing its pane to prepare
the profile. Launch activates only its lead channel and disables
inherited worker/operator plugins through session settings. No development
confirmation or worker-hook fallback is part of this operator head.

The service issues a separate random delegation for one launch, bound to the
exact machine, native seat and conversation. This is operator-lane authority for
that conversation, never the owner's general operator credential. Dedicated
fleet routes expose its lead tools and conversation channel; the delegation
cannot authenticate account, credential, settings or general operator HTTP APIs.
Client-supplied chat, pane or machine names cannot replace the bound identity.
The authenticated fleet transport and fresh native process evidence must agree
with that binding; possession of a worker fleet token is insufficient.

The machine must currently permit at least `workers`. Launch stays within its
approved worker directories. Each request rechecks the delegation, live seat
binding and machine ceiling; shell and screen actions retain their higher
ceilings. A remote lead cannot raise access levels or mint further operator
delegations. Its hires use the bound conversation's existing adoption and report
routing, including wakes and watches.

The secret travels in a private launch transport into process memory, never in
command arguments, scripts, plugin configuration, discovery files, receipts or
logs on the remote machine. Only nonsecret identity and bridge code persist.
Harness transcript/config persistence must not capture the launch secret.
This prevents application writes of the secret to disk; it is not protection
from the machine's administrator, memory inspection, paging or crash dumps.

Revocation invalidates the grant before acknowledging success. Every tool call
and channel poll checks current authority, including immediately before a
queued effect. Revocation stops new effects and closes channel access; it cannot
undo an already dispatched effect. Restart recovery preserves only the original
proved native lifetime, as amended below.
An uncertain launch or tool effect is reconciled by its original receipt and is
never automatically replayed.

## Remote workspace conversations

A workspace scope may carry an additive `machineId`. Lead launch alone creates
that scope, after `remoteWorkspace` approves the exact directory on the pinned
connection. Ordinary conversation creation refuses client-supplied remote
scopes. Current launches target Windows fleets: validate their fully qualified
paths with `path.win32`, and do not stat them on the service's Mac.

The seat context retains the machine identity. A remote workspace does not run
local captain turns or fall back to a local Pi session when its native receiver
is unavailable. Its reports and wakes still use the native conversation driver;
lead tools require the seat-bound delegation. The remote harness reads its own
project instructions; the service cannot read that workspace locally.

An unconfirmed launch retains its original receipt, `failedStage` and a bounded,
redacted error, and logs that same diagnostic. Delegation secrets are redacted
before either durable boundary. Reconciliation never launches a replacement.

## Verification and rollout

Trust-boundary checks cover wrong machine, seat and chat; worker-token rejection;
revocation and access downgrade; and exclusion from general operator APIs.
Live evidence must use a coordinated throwaway PC seat in a scratch chat, prove
lead-tool access and child adoption, inspect remote application artifacts for
secret persistence, and show a formerly valid call denied after revocation.
The live KH2 head started with its existing signed-in Claude Max profile and
called `worker_reports` through the bridge (VUH-1927). Tracker acceptance below
still requires a deployed head to read an issue and post a comment. Deployment
and the existing KH2 lead's context handoff remain coordinated owner actions.

## Tracker delegation (VUH-1968)

The head gets the connected tracker's ordinary `linear_*` reads and writes from
its conversation tool bank. Deferred `mcp_tool_search` and `mcp_tool_call` use
that same tracker-only catalog, including tools beyond the initial list. They
cannot reach other connected services. Raw GraphQL, owner repository overrides and persona-selectable
worker publishing are excluded; the head writes as Clankie, attributed to its
lead chat, rather than choosing another author. This retains the connected
account's existing tracker access; project leadership is not a provider-level
project ACL.

Every tracker call carries the bound conversation's authority. The MCP host
rechecks the delegation after asynchronous setup and at the actual write
boundary, with a synchronous revocation check immediately before dispatch.
Writes require proved chat attribution; they refuse rather than falling back
to an unattributed connected-account write. Other callers retain their existing
optional-attribution semantics. Calls already dispatched remain reconcilable
and are never replayed automatically.

The owner configures project-to-chat wake routes through `clankie linear routes
set --json-stdin`, preserving other projects' routes. The delegated `linear_wake`
accepts only `action: received` with the original host-issued `wakeId`, and only
for that chat. It cannot change wake rules, owner identity or project routing.
A removed/unavailable project chat retains the existing global fallback. Live
tracker and channel recovery verification remain separate from the HTTP/MCP fixture.

## Reconnection amendment (VUH-1980, 2026-10-09)

A service restart ends transport sessions, not the owner's original launch intent.
Private, bounded service records retain the token hash, launch binding and first
complete host-authored process proof. They never retain the bearer token. Recovery
accepts only that exact pane, shell/harness process lifetime, native session and
chat, after current fleet policy and proof checks. An unproved launch, unreadable
record, missing process or replacement carries no recovery authority. Explicit
revocation persists and fsyncs before success, and invalidates active grants at
once; restart cannot resurrect it.

A temporary relay, bridge or native-observation refusal still blocks that request.
It no longer aborts the native stdio bridge permanently. The bridge retries channel
polling and recovers its idle MCP generation after transport loss, notifying the
harness that its catalog is available again. Potentially admitted tool effects
are never replayed to reconnect. Status reports recent interruption as reconnecting,
then current when original-head polling resumes.

Legacy heads have neither this bridge artifact nor persisted hash/process proof.
They cannot be safely migrated by trusting a new caller's identity claims. The
owner loads the new artifact with an initial launch after deployment; subsequent
loss/restart recovery needs no new pane. No live PC operation is part of fixture
verification or code landing.
