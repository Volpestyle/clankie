# ADR 0259: Remote project leads use seat-bound delegation

Status: trust model accepted by James, 2026-10-09; implementation and proof pending.
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
for ordinary sessions; launch activates only its lead channel and disables
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
undo an already dispatched effect. Service restart invalidates ephemeral grants.
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
Implementation and live verification are pending. Deployment and the existing
KH2 lead's context handoff remain separately coordinated owner actions.
