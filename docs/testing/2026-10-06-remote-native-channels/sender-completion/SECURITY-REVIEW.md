# Native sender and completion security review

VUH-1527, 2026-10-06. Independent native Codex subagent
`/root/receipt_security` reviewed this source delta read-only in Tess's isolated
worktree. Final disposition: **approved; no remaining concrete source security
blocker**. The reviewer approved the sender/persona/completion delta including
the final Discord admission repair.

The reviews identified four concrete blockers, addressed before handoff:

- Missing `nextCursor` accepted an incomplete loaded-thread inventory.
  It now throws unavailable; the request is refused and any later request must
  repeat fresh proof through the original registration.
- A generic hire watch could begin harvesting before a steer acknowledgment
  armed its exact watch. The final acceptance guard now checks a superseding
  exact watch and the durable same-occupant/native-turn claim.
- Active-watch deduplication could re-arm an already harvested stable receipt.
  Persisted deny-only harvest claims survive removal and restart. They do not
  confer native authority or permit dispatch; the original pending watch alone
  may retry its own failed acceptance.
- Discord-owned wakes returned before final guarded native dispatch. They now
  await acknowledgment/admission separately from completion, using existing
  outbox/Pi callbacks. Current actor/route authority is revalidated after the
  awaited guard and again before posting the room reply. The original watch
  survives final acceptance rather than rejecting its own delayed census.

The unavailable-read handling, visible TUI endpoint narrowing, and shared subject
formatter passed the first source review. Native link/fleet, original process
lifetime, shell/socket binding, occupant, sole-thread and stream-owner checks
remain required. Unavailable final census reads defer the original wake; changed
native occupants remove it. No name-based aliases or receipt deletions were added.

The reviewer ran no suites or PC actions. This assessment does not prove deployed
PC delivery, completion, peer messages, or authenticated receipt settlement.

## Integration review

Pell's integration review reproduced a remaining admission failure: a native
delivery could finish unconfirmed without its admission callback, yet the wake
returned success and removed the durable completion watch. Retrying with a new
event after a late acknowledgment would risk delivering the same wake twice.

The integration repair reserves the original event ID, content fingerprint,
conversation owner and recipient binding in the watch journal before mailbox
dispatch. Unconfirmed attempts retain that watch. Later attempts inspect only
the original receipt under fresh source, owner and recipient checks; a missing,
conflicting or unacknowledged receipt cannot authorize another dispatch or a
fallback. Late replies without a durable acknowledgment remain unconfirmed.
Ordinary wakes also preserve the prohibition on fallback after uncertain native
delivery.

Four integration regressions exercise prior outbox uncertainty, late original
acknowledgment across the real retry interval, watch restoration after a late
reply without acknowledgment, and an admitted one-shot Pi turn with no response.
The latter cannot replay the turn or wake its designated head. These checks do
not replace new-intent owned-PC acceptance after deployment.
