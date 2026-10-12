# ADR 0266: Landing gates keep isolation and load less

Status: accepted by the lead for VUH-2148, 2026-10-11; landing pending.
Tracked by [VUH-2148](https://linear.app/vuhlp/issue/VUH-2148).
Builds on [ADR 0221](0221-tests-prove-the-product-and-its-boundaries.md).

## Context

The recorded 363-module landing selection spent 508.53 seconds summed across
workers importing during a 623.97-second test run. An instrumented collection
of those paths showed repeated eager snapshot, Pi and protocol schema imports
in isolated files. These are overlapping worker costs, not wall-time shares.

The lead approved gate priority first, then import seams. Host contention makes
uncontrolled comparisons noisy, so the evidence retains each exact selection,
raw diagnostics and limits alongside the measurements.

## Decision

Keep test assertions, timeouts, forks, per-file isolation and private fixture
state. Reduce the module graph loaded before a feature is used:

- Read and validate the bundled models.dev snapshot on first catalog use,
  preserving its synchronous API and memoized result.
- Load image resizing when processing an image. Voice imports the provider
  factory directly; Pi uses its narrow model utilities. Provider-family
  classification stays independent of SDK construction.
- Settings use protocol subpaths and protocol modules import their defining
  siblings. Preserve the public index exports and its Node-free Metro contract.

Separately, local integration batches acquire one service-owned full permit
across install and gate. Gate tickets precede ordinary full builds in FIFO
order between gates. New full/light builds and simulator reservations or boot
submissions wait while a gate is queued or running. Current holders finish,
servers keep their separate lane, and resource guards still apply. This needs
the updated service arbiter and workers; journal readability is not enforcement.

## Evidence and limits

[Import evidence](../testing/2026-10-11-vuh-2148-imports/README.md) records the
same 363-module collection at every stage. Baseline was 321.17 seconds wall /
1184.45 seconds summed imports; final was 253.76 / 924.12. These observed
reductions of 21% / 22% include changing host load and import instrumentation.
The protocol phase did not lower wall time versus the preceding phase. This is
not a full-gate pass or a controlled causal estimate. Pi coding-agent still
loads in 293 files through other service consumers.

Focused real catalog, image, provider and voice contracts passed 98 tests;
settings and protocol route contracts passed 61. Six package typechecks passed.
Real esbuild checks cover the bundled lazy catalog and browser protocol index.

The separate gate-priority evidence is in
`docs/testing/2026-10-11-vuh-2148-gate-priority/README.md` after its request lands.
Its native process/lock proof uses controlled admission inputs. A repeat passed
on the loaded Mac (2.48 load/core against the 1.5 policy) in 8.79 seconds; that
does not substitute for live before/after landing-gate timing. Exact-tree gates
and live timing after deployment remain required acceptance evidence.

## Revisit when

Revisit import seams when profiling identifies another repeated unused graph,
or upstream Pi offers stable narrow exports. Consider isolation changes only
with an independently approved contract preserving every existing isolation
guarantee. Revisit gate scheduling if ordinary work starves, remote execution
needs equivalent priority, or measured resource usage supports more concurrency.
