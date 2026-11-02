# #287 post-merge regression audit

Compared exact commits `20ae4712ad5a96ae335f1923224914aa84a859b2` and
`afa74da0f7a66efe61f1ca5bea5d308cde8c3261` in separate scratch worktrees,
with independent frozen-lockfile installs. All commands used `clankie heavy`.
Eight requested files ran together once on each Mac checkout. The two Linux-only
failures were then run on both commits in an owned Node 26.7.0 Bookworm Docker
container with independent installs. No paid model calls, service restarts or
new issues.

| File                                           | Before               | After                | Finding                                                                                                                                                                           |
| ---------------------------------------------- | -------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fixture-admission-boundary.integration.test.ts | Mac pass; Linux fail | Mac pass; Linux fail | Pre-existing: `Trusted fixture artifact unavailable at host startup`, bootstrap line 86 / test line 161.                                                                          |
| fleet-settings-worktrees.integration.test.ts   | Pass                 | Pass                 | CI's 60-second registration timeout not reproduced; local case took 13.35 / 17.67 seconds.                                                                                        |
| herdr-seat.test.ts                             | Fail                 | Fail                 | Pre-existing: expects `clankie-worker@clankie`, receives session `--plugin-dir` / `plugin:clankie-worker@inline` remediation.                                                     |
| opencode-fleet-lifecycle.integration.test.ts   | Pass                 | Fail                 | #287 regression: `native prepared hire survives...` expects `closed: true`, receives false. Missing optional tracker dependency now holds even a real non-Git research directory. |
| prune-evidence-disk.integration.test.ts        | Pass                 | Fail                 | Only observed after in these runs; attribution remains limited. See below.                                                                                                        |
| tracker-isolation.test.ts                      | Mac pass; Linux fail | Mac pass; Linux fail | Pre-existing: expects `bootstrap config rejected`, receives `Could not read Codex's apps...`.                                                                                     |
| harness-doctor.test.ts                         | Fail                 | Fail                 | Same pre-existing stale worker-channel remediation expectation as herdr-seat.                                                                                                     |
| question-mailbox.integration.test.ts           | Fail                 | Fail                 | Pre-existing: expected conversation-channel rejection, but command resolves `Answer sent to KH2 lead · VUH-2150. The ask has settled.`                                            |

Mac totals: before 67 pass / 3 fail; after 65 pass / 5 fail. Linux selected pair:
10 pass / 2 fail on each commit, with the same failing cases and messages.

## Disk test limitation

The after batch failed the free-space assertion at line 170: observed
`-822980608`, expected `> 134217728`. An isolated after repeat failed both that
assertion (`62259200`) and the APFS-clone assertion at line 197
(`-166416384`, expected `> -67108864`). CI had failed the latter assertion
with `-1073926144`. Three isolated before repeats passed.

These assertions sample machine-wide `statfs` free bytes across a shared APFS
volume, so unrelated allocations can change their result. The test, prune
implementation and its invoked prune path are unchanged by #287. All preceding
product assertions (removal, preserved evidence inode, removed caches) passed.
The evidence supports a non-isolated measurement failure; it does **not** prove
that this failure reproduces on the before commit. No disk-test fix is included.

## Confirmed regression fix

PR [#294](https://github.com/Volpestyle/clankie/pull/294) exempts an existing
directory only when Git positively identifies it as non-Git and no hire Git
baseline exists. A missing directory, unreadable checkout, lost recorded Git
checkout, or Git directory without a checkpoint reader remains `main_unknown`.
The original native close repro passes with the patch. New real-filesystem
service coverage and native close safety coverage exercise those distinctions.
Full focused-check totals and rebased CI evidence are recorded on the PR.

Raw before/after JSON reports, verbose logs, isolated disk repeats and the Linux
runner are in the evidence archive named in `evidence.json`.

## Earlier live GitHub proof in this session

The merged reader at `afa74da0` was called directly through its real `ghCliApi`
REST route, without fixtures:

- #279 head `f79056af856564cef98fe4d8b685b5524be4ed42`: no hold. #286 names
  merge `733bcdbb` and its red run URL.
- #285 head `78c07419524b329b8f1d5d275a40debbaa058588`: no hold. #286 names
  merge `38c302fc` and its run. #275 documents the landing failure but does not
  directly name that merge/run, so #286 provides the literal discharge.
- #287 head `cdcf95a04a86abc3c2294bd1b1d27c0ba063e62f`: `main_pending`
  while [run 41389309967](https://github.com/Volpestyle/clankie/actions/runs/41389309967)
  was active; after it finished red, no hold because existing #292 names
  `afa74da0`. The reader's specified matching rule accepts that SHA reference
  even though #292 discusses a different restart failure on that base.
- `Volpestyle/kh2-multiplayer` main head
  `df2ed3a892c44d80fba437135a9aa144a0d1dce7`: no hold; no main push runs.

Run 41389309967 finished red in all three post-merge jobs. Landing reports the
same unused `WorkerWakeEvent` type as #275. Most checkpoint/Mac failures match
#286; the eight newly reached file failures are classified above. Of those,
the native OpenCode close case is the confirmed #287 regression fixed here.
