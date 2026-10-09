# VUH-1897 item 1 / VUH-1925 batch 1: Linear schema subset

The provider fixture retains covered Linear contracts, credentials, authority,
request-budget protections and uncertain-write receipts. **No test or assertion
is deleted; product code is unchanged.** The five consumers and their reasons
are listed in the [fixture README](../../../apps/clankie/test/fixtures/linear-api/README.md).
The existing autonomous integration skip is preserved and was not executed.

| Scope                                          |    Before |   After |     Change |
| ---------------------------------------------- | --------: | ------: | ---------: |
| Provider-owned SDL lines                       |    52,706 |   2,528 |    −50,178 |
| Provider-owned SDL bytes                       | 1,335,039 |  63,691 | −1,271,348 |
| apps/clankie tracked test-directory text lines |   215,112 | 164,952 |    −50,160 |
| apps/clankie test assertion source lines       |   153,709 | 153,709 |          0 |
| Repository .test/.spec source lines            |   245,162 | 245,162 |          0 |

Test-directory totals include fixtures/helpers and exclude binary files; the
new raw-import type declaration adds four lines and expanded fixture provenance
adds fourteen. Assertion-source totals exclude fixtures. This is a test-data cut, not a unit-test deletion.

## What remains and why

Actual localhost-provider requests yield 46 distinct valid documents. Their
217 output fields, interface requirements and 152 complete input objects retain
upstream signatures, arguments, nullability, defaults, scalars and enum values.
Descriptions and unexercised output fields/types are omitted. An AST comparison
proves every copied field signature and entire input/enum/scalar definition is
unchanged. All 46 documents validate; the rejected `viewer { noSuchField }`
query retains its exact provider validation error. [Projection JSON](projection.json)
records the retained type/field list and audit results. The original pinned
upstream provenance and MIT license remain beside the fixture.

The fixture uses Vitest's native `?raw` import so the SDL is a real module
dependency for the existing root `--changed` selection. There is no new selector,
permissive schema, timeout change, test deletion or product change.

## Root-gate cost

Both arms use the same repaired runner, raw-import fixture loader, unchanged
assertions, fixed base `4114313be5284349f232ddb0a7729f1ab2e5ea11`, warmed native
lint artifacts and `TURBO_FORCE=true`. Turbo reports zero cached compiler tasks
in both, with the same one affected compiler project. Timing starts inside one
`clankie heavy` permit and excludes admission waits. Only the SDL content changes
between arms. No temporary query collector is present in these runs.

| Arm      | Root gate time | Vitest duration | Result                                | Load before → after (1 min /18 cores) |
| -------- | -------------: | --------------: | ------------------------------------- | ------------------------------------- |
| Full SDL |         71.58s |          24.43s | exit 0; 60 passed, 1 existing skipped | 13.28 → 17.18                         |
| Subset   |         65.77s |          17.49s | exit 0; 60 passed, 1 existing skipped | 17.18 → 16.04                         |

The gate saves 5.81s in this pair. This is one before/after sample on a shared
machine, not a claim of a repeatable speedup across all workloads. Both arms
select the same five consumer files; this is not a zero-test pass.
[Measurement JSON](measurement.json) retains phase times, commands, sources,
load samples and raw-report hashes. Local preliminary/capture runs and the
failed earlier after attempt remain under `.local/vuh-1925/` and are not used
as this pair's performance evidence.

## Prerequisite gate repair

The first after attempt fails before checks with `spawnSync git ENOBUFS`:
`execFileSync` buffers `git diff --binary HEAD` with its default 1 MiB limit.
This legitimate deletion produces a 1,452,303-byte diff. The gate now streams
that output into SHA-256 without a buffered stdout ceiling. It retains Git's
exit/error handling and source-stability refusal. The repair raises no timeout
and does not alter test selection. An independent streamed hash matches the
actual after-gate fingerprint, which also reports stable source; see
[fingerprint proof](fingerprint-proof.json). The repair lands as a separate
commit from the schema cut.

VUH-1897 items 2–5 remain unassigned. Unit-test pruning and the three-repository
inventory belong to subsequent VUH-1925 batches. Deploys and evals are excluded.
