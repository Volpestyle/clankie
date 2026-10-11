# VUH-2058: bounded compiler memory

Tracks [VUH-2058](https://linear.app/vuhlp/issue/VUH-2058).
Current operation: [typechecking](../../typechecking.md).

All 30 TypeScript package checks use the shared supervisor. Each native compiler
has a 2,512 MiB old-space cap and 16 MiB semi-space cap: 2,560 MiB total V8 heap.
The root Turbo task and compiler programs run serially. Large projects get one
source program and groups of 48 test roots. Original roots, global scripts,
declarations, augmentations, compiler options and explicit type packages remain
checked. The native Vox Cargo check is unchanged.

The 4.7 MB model catalog has an `unknown` JSON declaration. Its existing runtime
schema supplies the validated type, avoiding approximately 124,000 inferred
types and 537,000 symbols in consuming programs. Runtime source imports and
schema validation are unchanged.

## Measurements

Mac, Node 26.7.0, TypeScript 5.9.3, pnpm 11.11.0. Every compiler, test and
measurement ran inside `clankie heavy`; timers start after admission. The
formatter ran directly under the lead's interim rule.

| Measurement                                  | Reported compiler heap |     Types | Result                        |
| -------------------------------------------- | ---------------------: | --------: | ----------------------------- |
| Original service, source and tests           |          3,091,128 KiB | 1,167,377 | Pass at existing 5 GB ceiling |
| Original source roots only                   |          2,589,172 KiB |   882,912 | Pass                          |
| Source roots plus catalog boundary           |          1,915,168 KiB |   759,329 | Pass at 2,048 MiB old-space   |
| One app-importing test plus catalog boundary |          1,762,820 KiB |   648,330 | Pass                          |

Compiler `Memory used` is an end-of-check heap observation, not an RSS peak.
The native V8 cap bounds heap growth throughout each final compiler run.
The one-test measurement exposes the shared graph's roughly 1.7 GiB floor;
tiny test groups repeat that graph rather than eliminate it.

| Forced serial root typecheck                            | Wall time |     Tasks | Cache hits |
| ------------------------------------------------------- | --------: | --------: | ---------: |
| Before, on `cdd373cab`                                  |  199.99 s | 31 passed |          0 |
| Final 48-root programs, on `cf61cc10a` plus this change |  264.41 s | 31 passed |          0 |

The final run checks 30 TypeScript projects and the native Cargo task. The
compiler reports and every program's output are in the measurement bundle.
Largest reported compiler heap is about 2.06 GiB, roughly 18% below the 2.5 GiB
cap. The complete run adds 64.42 seconds over the before measurement. Source
bases include intervening main commits; machine load and GC also vary. Native
Cargo artifacts are warm and unchanged in both runs.

Against the lead's 42.7-minute release measurement, adding the entire final
4.41-minute typecheck gives a conservative **local projection of 47.11 minutes**,
without crediting the replaced compiler phase. This is not an observed GitHub
release result; no release or eval was run. Serial execution fits that allowance,
so compiler concurrency stays at one.

## Proof and retained failures

The focused real compiler, catalog and landing-selection regressions pass
**31/31**. They prove every original root and its imports remain checked,
cross-group globals still conflict, explicit dependency type packages still
resolve, a lower native heap budget fails visibly, a higher ceiling is refused,
and a changed shared compiler policy selects every project and invalidates a
previous gate. Focused lint reports no diagnostics; local Markdown links pass.

The original trace completed checking, then exhausted the existing 5 GB heap
while dumping types. Its complete `trace.json`, partial `types.json`, exact
failure and partial-dump analysis are retained in `failed-trace.tgz`; it is not
a successful complete trace. Full source-plus-test programs still exhausted
2,048 and 2,560 MiB old-space with the catalog boundary alone. A 1,664 MiB
old-space experiment also failed. An explicit desktop tool annotation had no
meaningful memory benefit and was restored.

Intermediate 128/64-root runs, cancelled work, initial config-resolution errors,
and failed regression fixtures are retained separately from the final passing
results. A 64-root group reached 2.18 GiB; the final groups are smaller. The
supervisor fails with the package, group, ceiling and retained output, telling
the next person to split the group or reduce its imported graph, rather than
raise the ceiling. CI and release workflows drop the 5 GB `NODE_OPTIONS` override
and upload compiler evidence after failure.

Raw compiler output, program roots/configs, trace analysis, source snapshot and
failed controls are objects in [evidence.json](evidence.json). Integrate owns
the exact-tree root gate; it was not duplicated locally. Its landing receipt
and final gate result are attached to VUH-2058.

The first exact-tree batch, `19cf44a0`, failed dead-code checking: Knip did not
recognize the compiler-consumed JSON declaration as an entry. That nonzero gate
is retained; the request was withdrawn before its next attempt. The declaration
now has a targeted workspace entry, matching the existing declaration entries.

## Follow-up

[VUH-2111](https://linear.app/vuhlp/issue/VUH-2111) owns a checked protocol
declaration boundary to lower the shared graph floor. No such boundary is
claimed here. Relative cross-app source imports still recheck service sources.
