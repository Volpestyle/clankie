# Clankie trim and account integration, with existing eval harvest

2026-09-30. Verified revision: `2f7335ecc107dbc1aafc75b8242a9158132ad01b`.
[VUH-1456](https://linear.app/vuhlp/issue/VUH-1456),
[VUH-1476](https://linear.app/vuhlp/issue/VUH-1476), and read-only harvest of
[VUH-1473](https://linear.app/vuhlp/issue/VUH-1473).

## Delivery result

`pnpm check` passed in a clean detached checkout of the fixed revision, after an
offline frozen-lockfile install. [Check output](checks.txt): 384 test files,
3,249 tests passed, two skipped; 27 typecheck tasks; 123 native Vox tests and IPC
smoke. Formatting, lint, dead-code, docs and infrastructure checks passed. Both
Claude and Codex generated-seat `build.mjs --check` commands passed. No new live
model trial was run for this verification or harvest.

The source revision contains trim `43e3a994`, account integration `4b13370a` and
`5e8c01af`, ownership correction `0ce6bb23`, and trim evidence `2f7335ec`. It
excludes the seat worker's uncommitted harness, tests and documentation. The
shared checkout's nine stale staged deltas were left intact: the corresponding
working files, including `instructions-pre-1456.md`, equal HEAD byte for byte.
No push, service restart, account registration, login or hook consent was done.

The app's account-label change remains at `30c2332`; its two files are unchanged
since the earlier passing app checks. Device rendering was not re-tested.
Runtime registration still contains only the implicit default home. After the
lead decides delivery, register the second home from the normal owner shell:

```sh
clankie accounts codex add ~/.codex-jamescvolpe --label jamescvolpe
clankie accounts codex list
```

An inherited worker `CODEX_HOME` makes that worker's overlay the implicit default;
use the owner's normal environment when configuring the owner registry. Selection
queries live quota and accepts weekly-only windows, with recent rollouts as
fallback. Earlier quota percentages are dated observations, not selection inputs
or assumptions about accounts that James has since reset. Hook consent remains
an owner action. The lead retains push/restart and issue-transition decisions.

## Completed trim gate

Recomputed from the two committed
[Codex gate reports](../2026-09-30-instruction-trim/README.md): 96 completed calls,
no missing cells, both halves finished without a guard stop. Each arm covers
16 cases three times.

| Arm        | Passed | Mean reported tokens/trial |
| ---------- | -----: | -------------------------: |
| `pre-1456` |  48/48 |                     63,543 |
| `trimmed`  |  48/48 |                     46,920 |

The mean reduction is 16,623 tokens/trial (26%). The standing instructions match
`trimmed.md` byte for byte, SHA-256
`2ef16da4e9fd4ae5f8ee9ecef7cd3f698bfc07737a6e9b8c86c54b3daea09c23`.
This is a ceiling-limited regression gate, not evidence of universal behavioral
parity. The earlier small Claude comparison remains partial and was not resumed.

## Budget hold and seat harvest

[Current budget direction](../quality-gates.md#current-live-eval-budget) is the
canonical mutable guidance. The five-repetition, 110-cell Codex seat campaign
was stopped at 106 persisted results. The active producer and its identified
trial descendants were terminated. Its pending post-reset shell timer was also
terminated; that timer would notify the Claude worker after 12:51 CDT. It was
not itself a Claude launch command. The native completion notification was
consumed, the pane settled, and its existing user draft remained intact.
No new campaign or completion watcher was created. No unrelated service, agent
pane, or Rivals job was stopped.

Original report, trial directories and credentials remain at their original
private temporary paths. The local handoff retains an untouched report/log
snapshot and exact process identities. [Sanitized harvested rows](seat-harvest.json)
preserve all 106 completed results and enumerate the four missing cells. The
interrupted in-flight work is not counted as a completed result. The original
report has no `finishedAt`; this was an owner budget stop, not normal completion.

| Codex arm | Completed | Passed | Integration coverage cases passed | Reported tokens |
| --------- | --------: | -----: | --------------------------------: | --------------: |
| `bare`    |     53/55 |  14/53 |                              5/25 |       6,002,376 |
| `current` |     53/55 |  20/53 |                              2/25 |       6,133,667 |

Model: `gpt-6-astra`, pinned source `4b13370a`. `current` used the trimmed
instruction hash above. No completed row reports a timeout or provider error.
Missing: both arms' `seat-where-things-live` and `seat-baseline`, repetition 4.
The five coverage cases are room posting, memory recall, voice summary, stuck
worker and escalation. Both arms see the same fake Herdr fleet, so bare's stuck
worker passes are possible by construction. These are bare/current results;
**there are no real `seat` arm results**, so they cannot establish the value or
reliability of the actual Claude seat. The paused Claude campaign must not
resume automatically on a quota reset.

## Why `configure-git-webserver` failed

This question concerns the earlier completed Claude/Sonnet 5.5 Terminal-Bench
baseline, not the Codex seat campaign above. The unchanged grader reports
`current` 0/5 and `bare` 2/5. Two initial setup-timeout rows are infrastructure
attempts followed by completed retries, not additional scored repetitions.
[Inspected result metadata](git-webserver-findings.json).

Every scored `current` run created a `git` account, substituted
`git@server:/git/server` for the requested `user@server:/git/server`, tested the
hook using a local-path push, and then cleared the sample repo/web file. The
verifier creates a key for the literal `user`, clones over SSH as that user, and
expects `/hello.html`. All five fail `test_hello_html_exists` with HTTP 404.
The trajectories explicitly acknowledge that SSH was not tested and that the
configured username differs from the requested one.

The bare successes need care: repetition 2 created both `user` and `git`;
repetition 1 used only `git` and left the sample `hello.html`. The verifier does
not fail immediately on the clone/commit/push errors, so a leftover sample can
satisfy its final HTTP check. That is a limitation of interpreting the reported
score, not a changed criterion or a regraded result. No holdout, grader or
benchmark fixture was edited and no trial was rerun.
