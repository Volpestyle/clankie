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
- Touched TypeScript files: lint passed. Source typecheck passed; test partitions
  and final integration landing gate are recorded by the landing request.

Initial checks found missing checkout dependencies (fixed with governed
`pnpm install --frozen-lockfile`) and an existing explicit remote override
regression (fixed; the full pane suite then passed).

## Live evidence pending deployment

The lead deploys after the integration request lands. This worker does not
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
