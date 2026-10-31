# TypeScript checks

Run `clankie heavy -- pnpm typecheck` from the repository root. A focused package
check uses `clankie heavy -- pnpm --filter @clankie/clankie typecheck`.
The package scripts all use `scripts/typecheck.mjs`; the native Vox task continues
to use Cargo. Turbo serializes package compilers, including on release runners.

Each compiler has a **2,512 MiB old-space ceiling** and a **16 MiB semi-space
ceiling**, giving Node 26 a **2,560 MiB (2.5 GiB) total V8 heap ceiling**. These explicit
Node arguments take precedence over inherited `NODE_OPTIONS`. This is a heap
budget, not a process RSS limit: executable code, stacks, native allocations and
the small supervising process also consume memory.

The supervisor runs the real TypeScript compiler with `--noEmit` and
`--extendedDiagnostics`. Each run retains its resolved root files, generated
configs, compiler output, memory measurement, wall time and result under
`.local/typechecks/run-*/`. CI's manual check and the release job upload that
directory alongside their QA reports, including after failure. Turbo hashes the
shared supervisor; changing it selects every project in the landing gate.

Each program is incremental: its compiler state lives in
`.local/tsbuildinfo/<project>/<program>.tsbuildinfo`, so a later check of the
same project rechecks only the files that changed and what depends on them. The
first check, or one after deleting that directory, is a full one. Pull request
CI restores the state from that pull request's last run, else from the latest
push to `main`, which seeds it (ADR 0310); on `apps/clankie` that took a check
from 292 s cold to 48 s warm.

## Program boundaries

Projects with more than 48 test roots get one source program and test programs
of at most 48 roots each. Every original root remains checked; imports are
resolved and checked normally in each program. Original declaration files,
global scripts and module/global augmentations are carried into every program
to preserve project-wide conflicts. Generated configs preserve the original
compiler options, project references and effective type roots.

Other projects retain one program. This avoids repeating small checks. Programs
are checked serially by default and stop starting new ones at the first failure.
`CLANKIE_TYPECHECK_JOBS=N` checks up to N programs of a project at once, each
under the same ceiling, for a machine with memory for N heaps; pull request CI
uses 3 on GitHub's four-vCPU Linux runner. Turbo still runs one project at a
time. A future test that pulls in
a much larger graph must still fit the same ceiling; the supervisor does not
silently increase the budget or skip that test.

The vendored model catalog uses an `unknown` JSON declaration and its existing
`CatalogSchema.parse` boundary. Runtime loading and validation stay the same;
the compiler no longer infers the entire 4.7 MB catalog. Relative imports across
applications still recheck service sources. A workspace-wide declaration build
was deferred: it would require a new emit/build contract for the existing
source imports. Bounded roots plus a measured central budget address the peak
without that migration.

## Investigate a failure

The failure names the package, program and heap ceiling and links its retained
output. Native heap exhaustion says `heap budget exceeded` and exits nonzero.
The message directs the next person to split an oversized group or reduce its
imported graph, rather than raise the ceiling. Normal TypeScript errors also fail,
with their original diagnostics. Missing memory diagnostics cannot produce a successful budget check. `pnpm check`
therefore fails before release builds proceed; run the gate before tagging.

Use `pnpm --filter PACKAGE typecheck --extendedDiagnostics` under `clankie heavy`
to print full compiler statistics. For a failure-path proof, invoke the supervisor
with `--heap-mb=16`; this diagnostic can only lower the old-space limit. Values
above 2,512 are refused. Inspect large inferred types and import graphs before
changing program boundaries. Trace dumping can itself consume much more memory
than checking; retain an incomplete trace as a failed measurement.

Compiler `Memory used` is the heap observed at the end of checking, rather than
a physical-memory peak. The native V8 cap bounds heap growth throughout each
compiler run. Measurements and total cold wall-time comparisons are recorded
with the [VUH-2058 issue](https://linear.app/vuhlp/issue/VUH-2058) and its evidence.
