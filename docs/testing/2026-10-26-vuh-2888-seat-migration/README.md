# VUH-2888: preparation release and exact-session migration

Tracks [VUH-2888](https://linear.app/vuhlp/issue/VUH-2888), implementing the lead's
preparation-release decision `beb11ba9-43f6-4582-9058-2a678914b45f`.

The shipped policy is **observe**. Legacy seats retain their tools while the
service records binding refusals. Doctor lists each binding and exact recovery;
observe and unknown-mode diagnostics follow existing readiness reasons, except
while an enforcing update is active or held for unready seats. A future artifact flips
the policy to enforce. Both checkout and official-release updater gates are
installed here. Observe retains the pre-existing stray-process gap until that
later release. No production deployment or restart was performed.

## Review corrections

This replaces the evidence for rejected candidate `6be8e6cb4`. All six required
findings are addressed:

1. Darwin discovery falls back from `proc_pidpath` to the executable path retained
   by `KERN_PROCARGS2` when a running binary was replaced/unlinked. The owned
   integration test copies Node, starts it as a launcher, unlinks that executable,
   and still obtains a complete census listing it. Removing the fallback kills
   that test. An unclassifiable process still holds readiness. No live fleet
   census was run by this worker.
2. Observe-mode census failures and unbound seats no longer replace existing
   doctor readiness headlines. The same report tests voice refusal with both a
   failed census and a complete unbound census; enforcing mode prioritizes the
   binding failure. Authenticated updater receipts retain the verified target
   policy as read-only evidence. Active enforcing installs/restarts and the
   latest `operator-seats-unready` refusal promote the binding blocker even
   while the service observes. Unknown modes, other operation IDs, completed
   cutovers and rolled-back updates preserve the voice headline. Removing this
   exception kills the doctor tests. Diagnostics remain in the body.
3. Separate tests isolate operator MCP dispatch, the conversation runner, native
   driver fallback, and timed lead failback. Each hold prevents dispatch or
   service takeover, and an unrelated conversation continues. The runner test
   deliberately omits the independent driver's guard so it cannot mask a defect.
4. Migration negatives now clear every other blocker: pending receipts and wrong
   identity after old exit; completion before claim with a valid bound successor;
   resuming holds; completion with only binding, readiness or a late receipt
   missing. A controller without a claimed bridge is explicitly unbound.
5. Checkout updates refuse enforcing and missing-policy targets before `down`,
   and roll back when binding recovery fails after restart. Pre-stop test
   recovery would succeed if admission were skipped, avoiding a masking guard.
   The actual release helper refuses `complete:false, ready:true` with no
   unbound seats to provide another blocker.
6. The upgrade was rerun against reachable committed source, described below.
   The archive includes the exact enforcing artifact diff and source binding.

A definite failure before successor spawn leaves the claim `resuming`. After
proving no successor exists, the same session/profile/cwd/conversation may be
resumed normally without `--migration`, then completed once bound and ready.
An uncertain spawn remains held. The claim is never repeated.

## Source and evidence binding

[proof.tar.gz](proof.tar.gz), with [archive.sha256](archive.sha256), holds sanitized
drivers, JSON receipts, owned runtime logs, check output and mutation logs.
The final proof is **run 10**. Preparation ran directly from commit
`bd10a28e4bef850e20b5bc2cf64985a6c00f40e3`, an ancestor of this candidate, rebased
onto `origin/main` at `3ae2db858a33751f8b38f931713d8ea47bfcdd6b`.
The driver requires a clean source tree and asserts that its preparation commit
equals that committed HEAD. The recorded tree is
`2a5e29918f7fdcdf1cd0df482e53ebc234d243b2`.

The scratch enforcing commit `4bd38d58c99730fc53dc4b6e639d9856f42bc2e7` differs
only in `apps/clankie/operator-seat-policy.json`. Its complete diff is archived
as `proof/enforcing-artifact.patch` and in `run-10/source-bindings.json`.
`proof/proven-to-candidate-source.diff` is empty: after the proven commit, only
this README, the archive and its digest changed. `proof.json` records matching
source hashes, checks that the proven commit is reachable from the candidate,
and checks that every mutation's original guard bytes match the proven source.
Earlier scratch snapshots in runs 1–9 are retained as history, not candidate
source evidence. The lead publishes the replacement archive to the evidence
store; the previous archive remains at its previous content-addressed link.

## Actual upgrade

```sh
PROOF_REQUIRE_CLEAN=1 PROOF_RUN=run-10 clankie heavy -- node --import ./apps/clankie/node_modules/tsx/dist/loader.mjs .local/vuh2888-proof/upgrade.mts
```

The archive retains that driver. It boots the full service from exact
`a9e39f3c91976b6395c0c1cee3821895e091a388` and uses that revision's actual updater
engine for the first upgrade, including real Git worktrees, pnpm installation,
state/link relocation and replacement-service health identity.

| Behavior                                 | Original receipts under `proof/run-10/`                                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Old seats keep tools across prep upgrade | `baseline-native.json`, first `update-*.json`, `legacy-doctor.json`, `legacy-call-after-upgrade.json`: two unchanged old launchers, observe mode, unbound census, actual protected message delivered after upgrade |
| Reconcile without replay                 | `original-receipt.json`, `original-reconciled.json`: a reply deliberately dropped after original dispatch, then reconciled after upgrade using the bridge's actual receipt ID                                      |
| Refuse early enforcement                 | Second `update-*.json`: `operator-seats-unready` before shutdown                                                                                                                                                   |
| Exact native handoff                     | Both `migration-*-prepare`, `*-living-refusal`, `*-new-call-refused`, `*-complete`: same UUID/profile/cwd/conversation, confirmed old exit, current launcher and bridge                                            |
| Enforcing cutover succeeds               | `ready-doctor.json`, final `update-*.json`, `enforcing-doctor.json`: both bound, healthy activation, enforce mode                                                                                                  |
| No duplicate effects                     | `continuity.json` and `native/*.events.jsonl`: original message once, distinct intentional post-upgrade message once                                                                                               |
| Launcher death cannot hide a seat        | `orphan-launcher-refused.json`: killing only the owned launcher leaves its native session visible, unbound and readiness false                                                                                     |

These are the real launcher, per-launch MCP configuration, stdio bridge, HTTP
routes, kernel observations, transcript resolver and receipt stores. The native
harness dependency is deterministic Node named `claude`, with owned transcripts
and the real SessionStart hook. It calls no model/provider and does not prove the
real Claude binary's trust UI. Supervisor ports stop, confirm exit and boot only
the owned scratch service instead of using the installed daemon supervisor.

HOME, all five XDG roots, CLAUDE_CONFIG_DIR, CODEX_HOME, temporary files,
credentials and state are scratch. Service/relay URLs use distinct random ports;
fixture discovery is confined to its explicitly owned PID file. The outer heavy
governor remains unchanged. No real service operation, broker/keychain, seat,
pane or model was probed. The kernel proof ran on macOS arm64; Linux's census
remains unproven here.

## Checks and mutations

- After the final rebase, the corrected core group had **54 passed** across
  six files, plus **7 passed** in the owner-delivery regression.
- Restored VUH-2816 native/route/registry/unbound-MCP/doctor/nonce suites:
  **49 passed**, including both real native cases executed.
- Doctor, checkout updater and actual release-helper integration: **56 passed**.
- Current service source, changed core tests, TUI project and changed updater
  tests typechecked; scoped lint and formatting passed. A real
  `pnpm install --frozen-lockfile` completed in this worktree; the final rebase
  changed no dependency inputs.
- **28/28 mutations killed**, each with a discovered failing test, then exact
  source bytes restored. `checks/r3-rebased-mutations/results.json` records each final command,
  replacement, original source hash and test result; adjacent logs retain the
  failures in `r2-mutations`, `r3-mutations` and `r3-rebased-mutations`. Unchanged
  guard receipts are reused only when their source hash still matches. Changed
  updater/doctor and rebased failback guards were rerun. The restored runs above
  are green.

| Mutations | Isolated boundary                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------- |
| B1–B4     | nonce, bridge ancestry, enforce/observe, claimed bridge required                                                |
| M1–M5     | old exit, one-shot claim, exact identity, resuming hold, prior claim                                            |
| R1–R5     | pending original at claim, bound completion, ready completion, idle preparation, pending original at completion |
| H1–H4     | MCP dispatch, conversation runner, driver fallback, timed failback                                              |
| U1–U7     | release pre/post gate, checkout pre/post gate, missing-policy default, enforcing policy, complete inventory     |
| C1, D1–D2 | deleted executable fallback, observe/unknown headline priority, pending enforcing update headline               |

The first corrected-fixture attempt exposed a selector that kept returning its
refused driver and a copied Homebrew Node missing its library path; both fixture
bugs are fixed and their failed logs retained. The original evidence's failed
attempts and ineffective first mutation configuration are retained and excluded
from successful proof. Root landing gate, Thea's replacement-patch approval and
the lead's landing window remain pending. No full check or eval was run.

A true-crash outer hire receipt still lacks a durable native-ID mapping, and
successful local native hire records may have been pruned. Unknown outcomes and
expired result bodies remain held. A later pane, matching arguments or missing
ledger entry cannot reconstruct that original result. The dropped-reply proof
covers reconciliation of a settled original; no replay or guessed settlement
was added. Real provider resume and production readiness must pass the same
exact-session gates during the lead/owner's natural restarts.
