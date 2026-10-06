# Fresh-intent admission security review

VUH-1527, 2026-10-06. Independent native Codex subagent
`/root/receipt_security` reviewed the candidate in Tess's isolated worktree,
read-only. Final disposition: **approved; no remaining concrete security blocker**.

The reviewer required and confirmed these corrections before approval:

- Explicit `undefined` cannot erase retained fresh metadata or its fingerprint.
- Pending project allocation compares the effective fresh intent and launch
  settings instead of silently substituting an earlier request. The receipt
  includes the resolved project identity.
- Both pending recovery and initial success perform awaited host, project and
  authority checks before the final exact native occupant lookup. A synchronous
  `current()`/closed latch follows that lookup with no further await before
  adoption and reconciliation.

The final review also confirmed canonical UUIDs, owner/body/sibling bindings and
permanent retention of fresh completions. Original settled receipts remain
fenced, and exact same-ID recovery neither sends nor relaunches. The host target
must still match the authenticated predecessor's configured connection.

This is a source security review, not proof of a successful Windows agent turn.
The [focused checks](CHECKS.md) passed after the final adoption fix. Deployment
and the owned-pane PC acceptance remain separate gates.
