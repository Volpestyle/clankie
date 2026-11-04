# Service tsc/native comparison — #391

Measured on `eb7e31a32fcb5a0acce0a0fe7e18753290004d17`, 2026-11-04,
macOS arm64, Node 26.12.0, tsc 5.9.3 and native TypeScript 7.0.2 (`typescript7`).
Raw reports remain in the measurement worktree’s `.local/tsgo-391/`.

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

Native median: 4.46 s; warm tsc mean: 39.33 s (8.8 times as long). Both
resolve the same 1,451 roots. All six clean runs return zero without diagnostics.
Runs were serial and interleaved under one `clankie heavy` permit, with
`CLANKIE_TYPECHECK_JOBS=1`. Timings include supervision and exclude queueing.
“Cold” means absent incremental state, not flushed filesystem caches. Other
fleet work continued; these shared-Mac observations are not speed guarantees.

RSS comes from `/usr/bin/time -l`, not V8 heap or aggregate simultaneous
process memory. The native compiler uses about 5 GiB; tsc’s V8 ceiling does
not constrain it.

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

The probe was removed in `finally`; both original package commands passed again.
No flags or assertions were loosened. This proves these cases on this snapshot,
not universal compiler equivalence.

```text
export const assignment: number = "wrong";
export function acceptNumber(value: number) { return value; }
export const argument = acceptNumber("wrong");
export const missing: { id: number; label: string } = { id: 1 };
export function narrowing(value: string | undefined) { return value.toUpperCase(); }
export class PrivateReadProbe { private unreferenced = 1; }
export const optional: { label?: string } = { label: undefined };
```

## Reproduce

In an owned fresh worktree with a frozen-lockfile install:

```sh
clankie heavy -- pnpm --filter @clankie/clankie typecheck:ts7
clankie heavy -- pnpm --filter @clankie/clankie typecheck
```

The exact measured compiler invocations were:

```sh
node node_modules/typescript7/bin/tsc -p apps/clankie/tsconfig.json --noEmit --pretty false
node scripts/typecheck.mjs apps/clankie/tsconfig.json --extendedDiagnostics
```

For timings, wrap these with `/usr/bin/time -l` inside `clankie heavy --`.
Keep sources unchanged; run native, tsc cold, native, tsc warm, native, tsc warm.
Use a fresh worktree rather than deleting shared caches.

For the negative sample, refuse an existing probe path, copy the fixture there,
and require exit 1 with the six diagnostics from each command. Remove only that
probe in finally and require both original commands to pass. Never commit the
invalid probe as `.ts`.
