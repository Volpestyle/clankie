# VUH-2945 filesystem-input landing selection

Selection proofs ran through `clankie heavy -- pnpm check:landing` in an
independent scratch clone with its own frozen-lockfile dependency install.
Each scratch commit changed exactly one file relative to implementation
`bf31d9ce96df1cdf4c87e861a990dd742beccea3`. None was pushed. Vitest supplied
private fixture HOME directories. No test retries were used.

| Scratch input                    | Commit      | Selected tests                              | Checks | Final exit |
| -------------------------------- | ----------- | ------------------------------------------- | ------ | ---------- |
| `native-process-proof.c` only    | `a0c6ef81c` | Five required suites, 32 passing tests      | 0      | 3          |
| Claude worker `plugin.json` only | `937a42807` | `harness-profiles.test.ts`, 9 passing tests | 0      | 3          |
| `docs/testing/README.md` only    | `762b8d5a2` | None                                        | 0      | 3          |
| Unmapped `unmapped-proof.c` only | `1e8ec01f8` | None; named in report and refused           | 1      | 1          |

Exit 3 holds the scratch checkout at the review boundary: review status returned
`Internal Server Error`. These green checks prove test selection, and do not
authorize pushing any scratch commit. The C-only run selected
`fleet-health-metrics`, `native-process-blocked-caller`,
`process-working-directories`, `tidy-worktrees-home-pane`, and `tidy-worktrees`.

The [raw proof bundle](clankie://evidence/sha256/d10403e6dcd869b74a87bd6071a1f483016a3e5e2884107119e8e445ba696f45) contains the full gate reports, logs, source identities, selected
modules and dependency graphs. The declarations are also recorded in the
per-test dependencies used by VUH-2044 revalidation. The landing-related
regression checks passed first attempt: 3 suites, 19 tests, including the new
incoming filesystem-input invalidation cases.

The subsequent `1d3f1abf8` guard change preserves executable modes from the base
for deletions and mode removal; it does not alter these mapped selections.
