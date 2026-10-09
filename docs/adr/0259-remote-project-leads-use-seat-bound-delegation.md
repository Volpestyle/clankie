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

## Verification and rollout

Trust-boundary checks cover wrong machine, seat and chat; worker-token rejection;
revocation and access downgrade; and exclusion from general operator APIs.
Live evidence must use a coordinated throwaway PC seat in a scratch chat, prove
lead-tool access and child adoption, inspect remote application artifacts for
secret persistence, and show a formerly valid call denied after revocation.
Implementation and live verification are pending. Deployment and the existing
KH2 lead's context handoff remain separately coordinated owner actions.
