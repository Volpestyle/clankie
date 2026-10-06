# Native security assessment: unmapped allocation

Reviewer: native Codex subagent `/root/receipt_security`, 2026-10-06.
Read-only assessment; no implementation approval or checks claimed.

The current recovery refusal is correct: local recovery, the host program and
the protocol require a recorded worker allocation. The retained launch flag
cannot prove that nothing launched. A census delta cannot assign receipt
ownership to `wH:p1`; `beforeIds` identifies transcript entries, not baseline
panes.

An explicit abandoned-with-unmapped-allocation tombstone can preserve original
at-most-once protection if its outcome remains unknown and these guards hold:

- Operator authority and exactly one retained original ID, nonce, key,
  fingerprint and configured host match the existing authenticated journal.
- The irreversible launch commitment remains. Persist permanent recovery
  fencing before awaits; no original hire or controller remains active.
- Require the existing host journal. The legacy missing-journal/new-claim
  fallback is unavailable for an unmapped allocation.
- Obtain a fresh, complete, stable panes/agents/process census under the host
  lock. Retain the original launch history, host identity, observation window,
  census hash and operator disposition permanently.
- Recheck authority, target and activity before local settlement. Never adopt,
  close or rename an unknown pane; never resend or relaunch the original.

Unknown abandonment must keep fresh admission blocked by default. Permitting
independently new work at the same location needs Clankie's explicit policy
decision because an unobserved original could still finish after census. The
existing fresh-intent gate admits ordinary settled siblings, so adding this
disposition without changing that gate would silently introduce that risk.

The smallest future checkpoint preserves Herdr's native `workspace/create`
`root_pane` response as layout-only metadata before any subsequent RPC and
checkpoints a worker immediately after creation. A layout root cannot become
the receipt's native worker `paneId`. Lost SSH replies need a host-side response
checkpoint; residual gaps remain honest uncertainty.

The initial assessment encountered unavailable SSH. Later read-only LAN evidence
matched the exact host journal and confirmed `launching`; the assessment's
unknown-outcome and fresh-admission requirements therefore still apply. No
settlement, source modification or guessed pane mapping followed the review.
