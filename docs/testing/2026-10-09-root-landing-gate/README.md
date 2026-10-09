# VUH-1896: Require the root gate; preserve its test selection

The existing root Vitest `--changed` selection catches all three reported
consumer breakages. The landings used hand-picked checks. This is a process
failure, not evidence for a new test selector.

| Historical landing                      | Root selection | Broken consumers selected                     | Unchanged consumer replay    |
| --------------------------------------- | -------------: | --------------------------------------------- | ---------------------------- |
| VUH-1870, `cb6e0b4b` against `733382a3` |      686 files | `captain-native-chat`, `seat-outbox`          | 12 passed, 7 failed (2 + 5)  |
| VUH-1869, `29d41394` against `4fb5ef8c` |      690 files | `opencode-fleet-lifecycle`, `worker-accounts` | 7 passed, 23 failed (20 + 3) |

The lifecycle snapshot has 20 cases. Its 21st pending-reply regression was added
later. The original VUH-1870 author explicitly records using hand-selected checks
and omitting the native-chat/outbox consumers in the
[delivery evidence](../../verification/vuh-1870-claude-delivery.md). VUH-1869's
historical evidence names eight focused files. Neither replaces the root gate.

[Replay JSON](replay.json) retains the exact commits, baselines, selected-consumer
membership, failure names/messages and hashes of the original reports. Collection
used the original root selector:

```sh
clankie heavy -- pnpm exec vitest list --config vitest.config.ts --changed PARENT_SHA --filesOnly --json=REPORT
```

The unchanged broken consumer files were then run with `--bail 0`. This proves
selection and the failures separately; it does not claim every consumer executed
in a broad run that stops at its first failure. Full historical root gates also
reject both landings.

## Required delivery and compiler scope

AGENTS.md, ADRs 0240/0247, the lead delivery reference and the worker `clankie`
skill now require repository-root `clankie heavy -- pnpm check:landing` after
rebasing onto fetched `origin/main`, before push. Hand-picked subsets support
iteration only. A source/base change requires another root gate. A zero-test
comparison after pushing is not landing evidence.

The runner retains HEAD, the fixed base SHA, source fingerprint, phase wall
times, compiler scope and exit in `.local/landing-gate.json`. A source change
while it runs fails the gate. Reporter arguments are allowed; caller-supplied
test filters and selection overrides are rejected.

Typecheck scope follows TypeScript's config inputs and native module resolution,
including type-only and relative imports across packages. Removed modules retain
their consumers through their previous contents. Compilers run serially; Cargo
uses one job, including through Turbo's strict environment filtering. Compiler or
dependency configuration changes check all projects. Vitest selection is unchanged.

The actual compiler-input hash participates in Turbo's native `globalEnv` cache
key, rather than relying solely on manifest dependencies. The real TUI
`accounts.ts` probe selects only TUI and Clankie (2 of 31 projects). Changing that
imported source changes Clankie's task hash from `76069ffc6fb78ee6` to
`a89ad1682b83f8e1`; the probe restores the source byte-for-byte. A separate
compiler-boundary fixture verifies relative type-only imports, deletion and
exclusion of an unrelated project. See [compiler boundary evidence](compiler-boundaries.json).

## Measured cost

Each arm uses a fresh, explicit private Turbo cache, serial compilers and warmed
native lint artifacts. All compiler tasks miss cache. Timing starts inside the
heavy permit, excluding admission waits. The after arm uses the new runner with
an alternate historical Turbo config declaring its compiler-input environment
hash. No historical test is changed. The existing `--changed`/`--bail 1` selection
is the same in both arms.

| Replay   | Whole gate before → after | Turbo compiler time before → after | Compiler projects | New graph cost |
| -------- | ------------------------: | ---------------------------------: | ----------------: | -------------: |
| VUH-1870 |         193.94s → 183.42s |                151.125s → 136.865s |           31 → 24 |          2.60s |
| VUH-1869 |         191.62s → 214.75s |                165.808s → 165.642s |           31 → 24 |          4.24s |

These are failing historical gate replays, not green full-suite timings. Both
VUH-1870 arms stop at the existing worker-link ACK failure; both VUH-1869 arms stop
at the lifecycle tab-name mismatch. The latter after arm also exposes the old
simulator-fixture fetch rejection, already repaired by VUH-1885 on current main.

Wall-time gains are mixed: the first replay saves 10.52s; the second costs 23.12s
more. The compiler graph removes seven tasks in both; the second pair does not
establish a compiler-time gain. Static phase times and the tests executed before
bail also vary on this shared machine. Do not infer that load caused the difference
from these samples alone. [Timing JSON](timings.json) retains before/after load,
phase times, exits, cache counts and source stability.

The untouched VUH-1870 root gate initially stops even earlier: knip reports unused
`heavyJobParallelism` at `packages/fleet-resources/src/parallelism.ts:2`. For the
matched cost comparison only, both VUH-1870 arms exempt exactly that historical
export in knip. This exemption is not landed. The VUH-1869 replay needs none.
The earlier mixed-cache diagnostic runs are retained locally and are not used
as performance evidence.

Raw reports, benchmark controller and native cache-hash probe remain under
`.local/vuh-1896/` in the owned worktree. The pre-push gate's checked HEAD,
base, result and receipt path are attached to VUH-1896. No new test selector,
timeout increase, deploy or eval is included.

## Full-gate result

Checked HEAD `270355afd6ff87d2367b412dc6ce52bdb57046fe`, fixed base
`56f8b527fe1af6d8fbaa061e01c1dd4822916078` (includes knip repair `ac076524`).
Root `check:landing` exited **1** after 802.23s; source stayed stable. All static
checks and 31 serial compiler projects passed. Vitest selected 862 files and
stopped after 2,960 passed, 1 failed and 15 skipped tests; 115 files passed,
1 failed and 3 skipped before bail. This is **not a green full gate**.

The only failure was the unchanged `fleet-ssh-recovery` case, “keeps the working
link through a failed renewal, then recovers a real promoted-relay outage.” At
`:433:73`, its 5-second fixture wait for ready on a different port reported
`expected false to be true`. A post-failure sample read load 74.24/73.39/54.98
on 18 cores. That sample alone does not establish the cause. This change touches
neither the case nor its imported product modules.

## Isolated passes

On the same checked HEAD and unchanged fixture/product inputs, the exact failing
case passed: **1 passed, 11 unselected, exit 0**, 9.53s command wall time. Before
load was 26.70/59.37/52.67; after was 25.47/58.02/52.27 on 18 cores. The 1-minute
load guard was healthy (ratio at most 1.5). Assertions, timeouts and product
defaults were unchanged.

The lead explicitly accepted this full-gate result plus isolated passes on
2026-10-09 and authorized landing. Subsequent documentation edits record that
rule; they do not change the checked runner, compiler graph or product/test
inputs. [Acceptance JSON](landing-acceptance.json) retains commands, results,
load samples, the exact failure and raw report hashes. Local receipts are
`.local/vuh-1896/landing-main.json` and `renewal-isolated.json`.
