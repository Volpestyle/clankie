# Binding-free Linear wake confirmation

[VUH-1743](https://linear.app/vuhlp/issue/VUH-1743/jamess-linear-comments-dont-wake-the-claude-operator-seat)
was rechecked on `f8d400ef`: 18 signed ingress/native mailbox tests passed,
but a fresh live owner comment exposed missing recipient identity.

The comment `56f87ce4`, created 2026-10-08T04:01:02.779Z, reached the Claude
operator as `seat-3261cd6d-ac06-407f-ac7f-ca51e14b47a3` at 04:01:06.586Z.
Webhook `91603edd-cb1f-4d59-82ab-20a60ca1e4b1` joined event
`55aff58e0c77ab62b6809b0aaeca2fd365ae306512c7b5eeb76f323d5af4d8d2`
to `global-default` / `project_fallback`. External cursor `000000041273`
retained the comment text/link. Run `run-0e120454-c994-4a18-8c75-73c2a1dabc05`
completed `delivered` at 04:01:06.676Z.

The native confirmation call at `000000041279` failed at `000000041280`:
`The original Linear wake recipient or receipt could not be confirmed`.
Its saved receipt had an ID/fingerprint but no `recipientBinding`;
notification `43eecabe-a04e-46a5-a884-eed434697641` remained unread.
That is delivery evidence, not successful consumption/read evidence.

The correction saves the host-synchronized native session identity before
an original without a fleet binding is offered. Empty native syncs also retain
the current identity. Confirmation requires the same saved session identity
and exact outbox receipt. Bound fleet originals keep their binding check;
identity-free historical originals remain refused, never retroactively adopted.

The owned integration exercises signed ingress, production runner/store/outbox,
authenticated HTTP seat polling and SDK `linear_wake`, plus the persistent
provider notification boundary. It covers binding-free confirmation after
restart, replacement-session refusal and missing-original-identity refusal.
No live credentials or model calls are used. The initial focused run caught
empty transcript syncs omitting identity; that path was corrected.

The old worktrees are reconciled by content: four exact `git cherry` matches
plus rebased copies. `2d23a90e`/`cadbd7d1` → `128ba91b`,
`7f7b2bbd`/`4c9732c6` → `38e39a87`, `d321e4dd`/`2a814cb9` → `7f22b04e`,
`bb1c9184`/`3fcc812a` → `90760740`, `ae292b3b` → `eb533c2f`.
Range-diff differences are surrounding docs/OpenAPI context and a fixture
owner-email default already supplied by current main; no abandoned patch remains.

Deployment and a **new** owner comment are needed to verify the repaired live
path. Follow the observation chain on the issue: webhook event ID → external
cursor/run → original wake ID/native identity → actual native channel and
successful `linear_wake received` → receipt `receivedAt` → notification `readAt`.
The original failed wake must not be replayed or edited to manufacture proof.
No live service restart was performed for this work.
