# Finished worker commit handoffs

Tracks: https://linear.app/vuhlp/issue/VUH-2152

`close_worker_pane` now accepts clean unlanded commits when every commit has a
live merge-queue request, a verified pushed remote head/tag, or a decision at
the current HEAD. Its durable close receipt and lead history keep `handoffs`
with kind, covered commit IDs, HEAD, worktree and request/ref/decision reference.
Unique merge resolutions count too. Public fleet snapshots retain their existing
schema; the detailed receipt is available through `worker_pane_history`.

Dirty files refuse even with `unlandedReason`. The existing deliberate override
for clean local commits and unreadable remote fleets remains available.
Automatic handoffs never treat an unreadable worktree as clean.

## Focused checks

All checks ran through `clankie heavy --`.

- Pane close integration suite: 34/34 passed, including actual Git worktrees,
  native socket boundary, current-HEAD decisions, stale decision refusal,
  partial remote coverage refusal, manufactured tracking ref refusal, pushed
  remote coverage and durable receipt reload.
- Queue integration case `a push request reads pushing`: passed. A live request
  covers its input; durable history loaded by another queue does not.
- Queue active and waiting withdrawal case: passed; cancelled inputs immediately
  stop covering commits.
- Touched TypeScript files: lint passed. Service source and all 13 test typecheck
  partitions passed (466.77 seconds); local record `.local/typechecks/run-sbJAnX/report.json`.
- Integration request `8f5e19b1-dbf3-47aa-9a08-949895cad9d8` pushed
  `72a9b94565eccce96b088454b5a4a59ded7f6622` on fetched base
  `425bb6b9326c28ea9e847acb310c112dd398d25f`. Its exact-tree root
  `check:landing` passed (exit 0; 750.07 seconds): 1,705 tests passed, 8 skipped.
  [Raw gate log](clankie://evidence/sha256/5f552338edb42b4d15298dd5b6723acbce33205e314ab039172642a26e89ad35)
  is retained by the evidence store and listed in `evidence.json`.
  A fresh fetch confirmed the pushed HEAD on `origin/main`.

Earlier request `39fc9efe-dc91-4982-9a97-6b5e7c61b231` was interrupted before
this change's gate or push when the service owning the queue exited. Its record
remains retained; the unchanged candidate `99e1af457` was resubmitted through
integration, not directly pushed.

Initial checks found missing checkout dependencies (fixed with governed
`pnpm install --frozen-lockfile`) and an existing explicit remote override
regression (fixed; the full pane suite then passed).

## Live evidence pending deployment

The lead deploys after the current queue drains, preserving its five live
requests. The code is landed; deployment and live receipts remain pending. This worker does not
restart the service. Its connected tool catalog does not expose
`close_worker_pane`, so the lead must run these closes and supply receipts.

- Basil `w47:p36`: approved by the lead for the pushed remote proof after deploy;
  HEAD `9d4bf3aed` also has a `worth_landing` decision. Remote coverage is checked
  before the decision so the receipt can identify the pushed handoff.
- Pixel `w48:p7`: only proves queue handoff while request `412b70f8` is live.
  Landing first changes this to a reconciled-on-main close, not queue evidence.
- Finch `w47:p2W`: attempt only to prove dirty refusal; leave the pane open.
- Decision-only live close: pending Sable `w4F:p8` finishing and the lead recording
  a current-HEAD decision. Integration coverage does not substitute for this
  requested real-seat proof.

Keep VUH-2152 open until the three live handoff states are evidenced.
