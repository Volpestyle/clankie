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

The [raw proof bundle](clankie://evidence/sha256/06e5742a0493ccae6b1eb706df63efecc02f123e50bd05386bbe7696427167d9) contains the full gate reports, logs, source identities, selected
modules and dependency graphs. The declarations are also recorded in the
per-test dependencies used by VUH-2044 revalidation. The landing-related
regression checks passed first attempt: 3 suites, 19 tests, including the new
incoming filesystem-input invalidation cases.

The subsequent `1d3f1abf8` guard change preserves executable modes from the base
for deletions and mode removal; it does not alter these mapped selections.

## Review follow-up

`0de070a64` adds real installer, worker-sandbox/keychain, fleet Python helper,
login and native-fixture consumers, and explicit non-Vitest coverage declarations
with reasons. An inventory check confirms every existing executable input has a
consumer or a declaration. Unknown executable inputs still fail closed, including
deletions; declared evidence-script deletions retain their recorded reason.
Declarations do not claim manual or release checks ran.

The new scratch-repository test runs the production gate, Vitest selection and
graph reporter; only unrelated static phases use inert fixture commands. It
asserts that a filesystem-only change runs its consumer and records its input
edge. The four positive checks passed without retries, including unknown
executable/deletion refusal, the tracked-input inventory, and declared deletion.

The bundle includes these controls, run in the independent scratch clone:

| Control                              | Result                                        |
| ------------------------------------ | --------------------------------------------- |
| Unchanged real gate/reporter         | Exit 0, selected consumer and recorded input  |
| M1: remove reporter filesystem edges | Expected exit 1, dependency assertion fails   |
| M2: disable the gate union           | Expected exit 1, mapped consumer does not run |

These intentional mutation failures are negative controls, not timing flakes or
recovered gate failures. The bundle also includes the deleted extensionless
executable proof on `1d3f1abf8`: exit 1 names the deleted executable.
