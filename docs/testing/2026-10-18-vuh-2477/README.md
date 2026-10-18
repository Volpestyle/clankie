# VUH-2477 — retirement after remote Herdr restore

Tracks: https://linear.app/vuhlp/issue/VUH-2477

The six recorded close attempts failed at the saved allocation's terminal-ID
comparison, before any process observation. The lead's pre-close census IDs
match the current roster, but differ from the original allocation IDs for all
seven seats. Herdr's retained session snapshot preserves their exact Claude
session UUIDs. Every seat also has an explicit `global-default` hiring owner,
a confirmed allocation with original process proof, a completed ordinary hire
receipt, and its matching authenticated remote `launching` journal. No missing
journal, receipt format migration, or plugin-version defect explains these
failures. Herdr restored the sessions into new terminal/process lifetimes;
retirement required the original lifetime and had no recovery route.

`diagnosis.json` archives the seven comparisons, journal matches and hashes of
the read-only source captures. Original captures remain in the worker's ignored
`.local/vuh-2477/`. The pre-close terminal IDs are from lead message #2 (SSH
`herdr agent list`, about 17:59Z). Six exact failure receipts at about 18:00Z
were independently read from the retained native lead transcript; pB was not
attempted. The lead closed the seven panes at 22:23Z before implementation.
This worker never typed into or closed a PC pane or edited runtime state.

| Pane      | Original terminal    | Pre-close terminal  |
| --------- | -------------------- | ------------------- |
| pc/w18:p1 | term_65dd6b4206e1e3  | term_65e0ec88ae6a11 |
| pc/w18:p2 | term_65dd6b74e19944  | term_65e0ec88ae7112 |
| pc/w18:p4 | term_65dd78d9f5e447  | term_65e0ec88ae72c3 |
| pc/w18:p9 | term_65e01b260f0d7d  | term_65e0ec88ae80b6 |
| pc/w18:pB | term_65e035f07e86bf  | term_65e0ec88ae82f7 |
| pc/w18:pC | term_65e0361ec23b710 | term_65e0ec88ae84a8 |
| pc/w18:pD | term_65e03654e71ed11 | term_65e0ec88ae8689 |

The existing close API/CLI now recovers retirement authority only for an
explicit persisted hire with one exact completed receipt, the unchanged host,
a unique idle session census in the original pane/directory, and a fresh native
process proof pinned through every final close guard. Conflicting owners refuse.
The close history retains `restoredHire`; original launch provenance stays intact.
Unconfirmed launches retain their existing settlement/original-process rules.
No messaging, adoption, project membership, replay or worktree deletion occurs.

The archived `proof.json` bundles `diagnosis.json`, the native capture, logs,
the checked diff and source hashes.

Proof:

- `restored-tests.log`: 16 focused cases pass through production Herdr parsing,
  a real Unix socket, real ownership/allocation/receipt/report journals and real
  Git worktrees. They cover recovered retirement with stale or missing launch
  proof; draft, dirty-work, results, other-lead, adopted/unknown/conflicting-owner,
  missing-receipt, duplicate-session, changed-host, unavailable-process and busy
  refusals; and final process-birth/host revalidation. The ordinary completed
  receipt golden comes from p1; its target host/nonce are replaced for isolation,
  and tests translate its native identity and directory into their fixture.
- `pane-tidy-tests.log`: the complete pane-tidy integration suite passes before
  the final three added recovery cases; the root landing gate reruns the final
  tree's selected tests.
- `native-test.log` and `native/proof.json`: a disposable real Herdr server,
  Codex TUI/app-server and kernel process observer verify the process/session,
  then **refuse** restored retirement because Herdr reports lifecycle `unknown`.
  The pane, allocation and original receipt remain present. This proves the
  native unknown-state guard, not successful native retirement. No model request
  or owner credentials were used. Fixture-owned processes are stopped in teardown.
- `native-missing-helper.log`: the initial native attempt could not observe
  processes until this fresh worktree's native helper was built through
  `clankie heavy -- node scripts/build-fleet-proof.mjs`.

Successful retirement of a restored live Windows pane remains untested: the
seven production panes were already closed by the lead. The successful path is
proved at the socket/journal/Git boundary; native evidence proves safe refusal.
Integration and deployment belong to the lead. Root gate details and checked SHA
are reported separately in the worktree's `.local/landing-gate.json` and lead report.

[VUH-2471](https://linear.app/vuhlp/issue/VUH-2471) has a different attribution
gap. Allocation `1460c2eb` has no pane, seat or occupant; the reported `7e3ddc98`
receipt is absent from both retained journals. A separate resume fence
`7e0296f8` and its remote `launching` journal exist at the same directory. That
is not enough to bind the unknown allocation to this receipt. It remains fenced;
this change neither releases it nor labels its launch or delivery settled.
