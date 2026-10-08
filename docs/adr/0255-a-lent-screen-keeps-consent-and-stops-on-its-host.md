# ADR 0255: A lent screen keeps consent and stops on its host

Status: Accepted (2026-10-08), VUH-1803. Extends ADR 0244 and ADR 0199.

## Decision

A joined Mac or Windows PC can provide Clankie's computer body. The existing
computer API and CLI select a registered joined machine explicitly; omitting
the selection preserves the self-hosted local computer. An unknown or unavailable
selection never falls back to a different desktop. Hosted Clankie has no local
owner desktop, but can reach a screen the owner lends.

Screen traffic uses the authenticated, encrypted outbound join channel. Its
screen handler accepts a strict computer command contract, not code or a shell.
Screenshot frames use bounded authenticated chunks within the existing envelope
budget. The receiver never truncates structured computer data into a successful
result. Input receipts contain no screenshot bytes. Frames retain their digest,
lease, conversation and freshness checks while travelling between hosts.

Both ends enforce current screen-level policy. The receiver intersects the
authenticated policy with its original owner-approved join ceiling and refuses
stale, missing or invalid policy. Every queued effect rechecks that boundary.
An incoming level or service assertion cannot create host consent.

Consent belongs to one computer session and conversation. The owner grants
observation locally; input remains off until explicitly allowed for that session.
Clankie's visible driving indicator offers Stop. The host owns native capture
and input implementations for macOS and Windows; it does not redistribute
Peekaboo or Codex's computer-use implementation. Unsupported platforms refuse.
The first landing supports native accessibility press and literal text append,
with explicit foreground choice and an exact changed accessibility field. Raw
key, drag and scroll refuse. Their extension and native quiescence proof are
tracked in [VUH-1840](https://linear.app/vuhlp/issue/VUH-1840).
The existing self-hosted Peekaboo and explicitly attached Windows harness paths
remain available under their original authority contracts.

One host lease serializes driving. Native helpers check the exact target,
permissions, current session, owner consent and person takeover before input.
They refuse secure input, unavailable approval and ambiguous effects. Sign-ins,
codes, CAPTCHAs, payments, account changes and destructive actions retain
ADR 0127's person-only stops. Interface content never establishes authority.

Stop fences future and queued input immediately. Lowering access, disconnecting,
losing the indicator or native helper, and losing policy freshness do the same.
Recovery and stop remain available after a level reduction. A lease is released
only after its host proves quiescence; an uncertain stop keeps it held. Unknown
receipts and lost replies are never replayed with a new request identity.

The desktop app supervises the host's existing join process through strict
JSON events and local stdin status/Stop commands. That parent-owned control
channel carries no consent or input-enable command. Losing it fences the
screen. Finite registration status and explicit leave use the same CLI; a
stopped process is distinct from a revoked registration or a quiescent screen.

## Verification and live gaps

Use isolated settings, broker stores, real encrypted HTTP join transport and
disposable computer state to prove policy reduction, session consent, chunked
media, no fallback, no replay, queued-input stop and retained uncertain leases.
Compile the authored native helpers without taking a real screen or approving
native permissions. This is source and protocol evidence, not native driving
evidence.

The named live gaps are a short task on a lent Mac and on a lent Windows PC,
captured with the visible indicator, owner input opt-in, person takeover and Stop.
Hosted routing and its live rollout belong to clankie-ops. No worker drives an
owner's real desktop or changes its permissions as part of this landing.
