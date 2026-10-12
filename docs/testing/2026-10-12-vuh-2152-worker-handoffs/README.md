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

## Completed live proof on deployed runtimes

The lead ran the real `close_worker_pane` calls on 2026-10-12 at 07:52–08:38 UTC,
on runtimes `aaffb3d03` and `5e850e02e`.
This worker prepared the owned scratch trees and inspected the persisted close
entries plus the lead-supplied refusal tool results; it did not restart the service.

| Case                               | Live result                                                                                                                                  | Receipt                                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Pushed remote: Basil `w47:p36`     | Closed with `remote_ref`, covering `8f3304b6b` and `9d4bf3aed` under `origin/refs/heads/feat/vuh-1756-idle-cutover@9d4bf3aed...`             | Close `a1799795-ffe0-4b3d-a35c-5f1287e4081b`                                                  |
| Decision-only: scratch `w48:pF`    | Local-only commit first refused (1 commit, 0 dirty files); then closed with exactly one `safe_to_drop` handoff for HEAD `d360a68a2`          | Decision `58523002-7c95-4aa1-8f1f-c94856900942`; close `b145db1e-e6e5-48c9-a803-366040535fb2` |
| Dirty: scratch `w48:pG`            | Refused with `unlanded_work`, 1 dirty file and 0 unlanded commits; explicit `unlandedReason` also refused                                    | Lead's verbatim tool results in the archive                                                   |
| Dirty cleanup                      | After removing only the owned probe file and confirming clean status, the scratch seat closed without handoffs                               | Close `a1dd1ae5-1eaf-41e5-bc24-88f6b532b515`                                                  |
| Live merge queue: scratch `w48:pH` | Closed with exactly one `merge_queue` handoff for probe `5da37edc3` while its real gate-only request was composing; request has `push:false` | Request `e01881e1-942a-4c85-a571-c4166febcce9`; close `e314bc4b-758c-46ed-bb8f-e8115b7f4e11`  |

[Complete live receipts and refusal results](clankie://evidence/sha256/92a73c7823d270fc326b0cf08e9e007be18c782c39e5b6372204df8e1a100319)
include the unchanged landing gate log, selected persisted close fields, the
lead's verbatim refusal JSON, and the queue request/worktree records. Worker
conversation text was excluded. The earlier partial archive remains in the manifest.

Finch `w47:p2W` closed correctly: its pane directories were clean and its commits
were landed by content. Work in other worktrees is outside that pane's close
guard; this was not dirty-refusal proof. Odile's earlier refusal had 1 unlanded
commit and 0 dirty files and proves clean unlanded refusal only.

All requested live handoff states and both refusal boundaries pass. The queue
probe was prepared in `/Users/james/dev/clankie-wt/vuh-2152-proof-queue` on fetched
main `5e850e02e`; its local-only SHA is
`5da37edc353103cc6ec6df2e01b2dafd4291b098`. The persisted close handoff names this
exact SHA and request UUID. The gate-only request finished normally at 08:41 UTC
with gate exit 0 and `push:false`; it did not push this disposable probe to main.
Pixel's old/interrupted or
already-landed request was not used as queue evidence.
