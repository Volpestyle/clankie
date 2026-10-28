# VUH-2924: closing a seat no longer fails its issue on its own exit

Tracks: https://linear.app/vuhlp/issue/VUH-2924

## Close settlement ("changed occupant")

`close_worker_pane` returned `issue: {outcome: failed, detail: "Native hire
attribution is unavailable or changed occupant."}` for ordinary local Claude
seats: Maren (VUH-2919), Pippa (LOCAL-VUH-55) and Piers (VUH-2923, 13:21Z).
In the service log, each close was the only "changed occupant" line for that
issue. The first retry about 30 seconds later either settled or failed for a
different reason. VUH-2923 was already Done, so its retry was skipped.

**Cause.** That message is thrown only where a roster round captures a seat's
attribution. A retirement uses the closing seat's last confirmed capture, so
the refusal can only come from the check for a live successor. Roster rounds run
alongside tool calls. A round that read the roster before the close still
lists the exiting seat, and by then its capture can't prove the occupant. The
round put the closing seat back among the unknown owners, and the retirement's
successor check found a seat naming the same issue. So the closing seat
counted as its own possible successor, and its refusal became the result. A
round whose stale capture still proved the seat could also track it again, so
it would later "exit without a close" and pause its issue.

**Fix.** The keeper records when the lead closed each seat. The captain passes
each round the time it read the roster. A round that read the roster before a
seat's close ignores that seat: it doesn't count as a live owner, an unknown
owner or present. A round that read the roster afterwards sees the seat as
usual, so a seat that really comes back still owns its issue.

**Proof.** In `seat-issue-settlement.integration.test.ts`, the production
keeper, hire ledger and built-in tracker interleave the close with a roster
round, step by step and without timing. On origin/main the close returns the
live error (`close-race-origin-main-result.txt`):
`{"outcome":"failed","issue":"LOCAL-VUH-4","detail":"Native hire attribution is unavailable or changed occupant.",...}`.
With the fix it records "Piers left: work landed. Status kept: In Progress",
and a later stale capture neither tracks the seat again nor pauses the issue.

Corvin's review added two cases where the close lands while the round waits
on the seat's tracker: one capture still proves the seat, the other fails.
Removing the catch skip fails the failing-capture case. Removing the post-await
skip together with the present filter fails the proving-capture case. On
origin/main all three new cases fail (`close-race-mutations.txt`).

## Native census test (NOTE 5)

"seals a real Herdr/process census..." failed on main with
`['not_ready','not_ready']` (`native-census-red-origin-main.txt`). Its fresh
hire predates VUH-2256: a work hire must now state `effort` and
`effortReason`, and is admitted against observed plan usage. Without them,
every launch stopped at `not_ready` or `harness_unavailable` before the owner's
preparation denial that the test proves. The fixture now gives both, and the
seal, restart and late-launch assertions are unchanged. With
`HIRE_RECEIPT_NATIVE_TEST=1` on an isolated Herdr, all 19 tests in
`remote-hire-receipts.integration.test.ts` pass, including the three native
ones.

## NOTE 2

The unconfirmed-hire refusal and the auto-tidy hints now name the operator
route, `clankie hire-receipt settle <id> adopt|abandoned`. A non-operator
lead's `settle_hire_receipt` can't adopt or abandon a local receipt.

NOTE 3 (Windows cwd containment) is not done. It changes the digest-pinned
remote host program and only acts on Windows, which this change can't prove.

## Results

`green.json` (in the evidence store, see `evidence.json`) has 37 of 37 passing, with native tests on, across
`seat-issue-settlement`, `seat-issue-status`, `seat-issue-scope`,
`auto-tidy-adoption-fence` and `remote-hire-receipts`. `apps/clankie`
typecheck passes. No live pane, seat or tracker item was touched; the live
log was only read.
