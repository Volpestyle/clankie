# Service tsc/native comparison — #391

Measured on `eb7e31a32fcb5a0acce0a0fe7e18753290004d17`, 2026-11-04,
macOS arm64, Node 26.12.0, tsc 5.9.3 and native TypeScript 7.0.2 (`typescript7`).
The table below retains the timings and RSS; the negative fixture and exact
compiler commands follow. Full machine-local reports live under `.local/tsgo-391/`
in the measurement worktree; generated reports are not committed.

The existing opt-in service command landed in #867. This experiment reuses it;
it changes neither the bounded tsc gate nor CI's existing native check.

| Check      | Wall time | Peak RSS | Errors / exit |
| ---------- | --------: | -------: | ------------- |
| Native 1   |    4.46 s | 5.02 GiB | none / 0      |
| tsc cold   |  212.21 s | 2.60 GiB | none / 0      |
| Native 2   |    4.61 s | 5.01 GiB | none / 0      |
| tsc warm 1 |   39.18 s | 1.21 GiB | none / 0      |
| Native 3   |    4.33 s | 5.02 GiB | none / 0      |
| tsc warm 2 |   39.49 s | 1.22 GiB | none / 0      |

Native median: 4.46 s; warm tsc mean: 39.33 s, about 8.8 times slower.
Both compilers resolve the same 1,451 root files. All six clean runs return
zero without diagnostics. Runs were serial and interleaved under one
`clankie heavy` permit, with `CLANKIE_TYPECHECK_JOBS=1`; each command includes
compiler supervision. Queue time is excluded. “Cold” means no prior incremental
state in this worktree, not flushed filesystem caches. Other fleet work was
not stopped. These are observations on a shared Mac, not speed guarantees.

RSS comes from `/usr/bin/time -l`: it is neither the supervisor's V8 heap metric
nor a sum of simultaneously live processes. The native compiler's roughly
5 GiB RSS exceeds tsc's measured peak. The tsc V8 ceiling does not constrain
the native compiler.

## Negative cases

This fixture was temporarily placed at
`apps/clankie/src/__typecheck_391_probe.ts` on the same tree. Both real compilers
returned exit 1 and the identical six file/line/column/code/message diagnostics:

| Case                                              | Diagnostic |
| ------------------------------------------------- | ---------- |
| Wrong assignment type                             | TS2322     |
| Wrong function argument                           | TS2345     |
| Missing required property                         | TS2741     |
| Missing undefined narrowing                       | TS18048    |
| Unread private field                              | TS6133     |
| Explicit undefined with exact optional properties | TS2375     |

The probe was removed in a `finally` block. Both original package commands
then passed again. No assertion or compiler flag was loosened. This sample
proves these cases on this snapshot, not equivalence for every future program,
all packages, or all library types.

```ts
export const assignment: number = "wrong";
export function acceptNumber(value: number) {
  return value;
}
export const argument = acceptNumber("wrong");
export const missing: { id: number; label: string } = { id: 1 };
export function narrowing(value: string | undefined) {
  return value.toUpperCase();
}
export class PrivateReadProbe {
  private unreferenced = 1;
}
export const optional: { label?: string } = { label: undefined };
```

## Reproduce

Use an owned fresh worktree and its own frozen-lockfile dependency install.
Run both existing package commands through the governor:

```sh
clankie heavy -- pnpm --filter @clankie/clankie typecheck:ts7
clankie heavy -- pnpm --filter @clankie/clankie typecheck
```

The exact measured compiler invocations were:

```sh
node node_modules/typescript7/bin/tsc -p apps/clankie/tsconfig.json --noEmit --pretty false
node scripts/typecheck.mjs apps/clankie/tsconfig.json --extendedDiagnostics
```

For timings, wrap these invocations with `/usr/bin/time -l` inside the
`clankie heavy --` command. Keep source inputs
unchanged; run native, tsc cold, native, tsc warm, native, tsc warm. A fresh
worktree supplies the absent incremental state; do not delete another seat's
cache or flush system caches.

To repeat the negative sample in that owned worktree, first ensure the probe
path does not exist, copy the fixture above there, then run both package commands.
Each must return exit 1 with exactly the six diagnostics above. Remove only that
probe in a cleanup/finally handler and require both original commands to pass.
Never leave the intentionally invalid source in the tree or commit it as `.ts`.
