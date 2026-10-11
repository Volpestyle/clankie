# VUH-2105: reconcile the settled original without duplicating it

Tracks: https://linear.app/vuhlp/issue/VUH-2105

Requested fresh worktree `fix/vuh-2105`, off fetched `origin/main` at
`cf61cc10a9b0af7558b84d6b9bc40c8a7d137269`. The source checkout was not edited.

## Confirmed cause

The owning conversation retains both Juno IDs, `0844f669-00d5-4283-a2d3-660f8c4d5567`
and `3517b484-d276-4bc3-a8e5-859aacf576a1`. They have identical text, native binding
and pane; both report delivered. The retained evidence publishes only receipt
IDs, dates, stages, payload fingerprints and equality results, not private text.

The original sender unlinks its claim when a GET confirms stored, then refuses
this invocation's different follow-up. A subsequent exact-text call sees no claim
and allocates a new POST/ID. The unchanged implementation reproduces that duplicate
against the real service receipt stores over HTTP; the regression fails with a
new ID instead of the original. A specific historical worker's loaded source was
not instrumented, but its duplicate acceptance and this code path are verified.

## Result and deliberate-repeat boundary

Only reconciliation of an uncertain original to authenticated `stored` opens a
five-minute matching window, saved separately from the exclusive unresolved claim.
A matching native binding and normalized text returns the original receipt without
another POST, including across bridge restart. Fresh distinct intent closes the
window under the claim lock. After expiry the same status text is new intent;
ordinary successful POSTs never open a window. Unresolved claims have no new expiry.
A delayed old GET cannot reopen a window after a newer original takes the claim.

The settled-original refusal says plainly that the original is stored and the
follow-up was not sent, and directs a deliberate distinct follow-up instead of
resending the original. Its detail survives the MCP display projection.

## Checks

- **87 tests passed in seven focused suites**: real HTTP recovery, sender claim
  fences, peer-path consumer, MCP bridge, worker status, receipt boundary and
  protocol display projection.
- The acceptance sequence is covered: uncertain original settles, distinct
  follow-up is refused, exact normalized resend after bridge restart returns the
  original ID, only one original POST/effect exists, then distinct intent delivers.
- Same text sent an hour later delivers a new report, both after distinct fresh
  intent and without any intervening distinct report. An extra final focused
  case also proves a normal successful fresh POST opens no match window, so its
  next identical deliberate report delivers too.
- Only the sender's supplied clock advances to represent the hour; real HTTP,
  real disk stores, service processes and effects remain in use.
- Both Clankie and TUI typechecks passed. Formatter ran directly on all touched
  files; generated worker MCP projection check passed.
- No local full root gate or eval ran. `evidence.json` retains the old failure,
  current passes, sanitized live trace, full patch, sender and service fixture.

## Remaining verification

Land and deploy the bridge code, then confirm the loaded native worker path.
Do not replay an existing live status note or restart someone else's lane as a
probe. Legacy claims already deleted by the older sender cannot be reconstructed
from an empty local journal; this change neither edits live receipts nor invents
historical IDs. Lead owns closure.
