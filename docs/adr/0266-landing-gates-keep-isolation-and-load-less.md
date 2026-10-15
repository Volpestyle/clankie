# ADR 0266: Landing gates keep isolation and load less

Status: accepted by the lead for VUH-2148, 2026-10-11; landed 2026-10-12.
Gate scheduling amended 2026-10-15 for [VUH-2291](https://linear.app/vuhlp/issue/VUH-2291).
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
across install and gate. Amended 2026-10-15 (VUH-2291): gate tickets use the
ordinary full FIFO queue and share heavy slots with builds. They no longer
block new full/light work or simulator reservations and boot submissions.
Normal capacity and pressure guards apply; gates held over fifteen minutes
appear in `holderAlerts`. The core retry pass reruns only failed files, with one
five-minute deadline for the whole pass; a timeout blocks recovery. This
replaces exclusive gate priority after batch 329f5725 held off nine requests
for 42 minutes with three heavy slots idle. Sharing requires the updated
service arbiter and clients. Direct landing remains the default under
[ADR 0240](0240-changes-land-directly-on-main.md).

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

The separate [gate-priority evidence](../testing/2026-10-11-vuh-2148-gate-priority/README.md)
records its native process/lock contracts and successful exact-tree landing.
Its native process/lock proof uses controlled admission inputs. A repeat passed
on the loaded Mac (2.48 load/core against the 1.5 policy) in 8.79 seconds; that
does not substitute for live before/after landing-gate timing. The priority exact-tree gate passed 6,468 tests and pushed at `bd64bfb86`.

The [live priority capture](../testing/2026-10-12-vuh-2148-live/README.md) after
the 09:50:38Z deployment records the next real batch: install 11.870s and
gate 446.746s, exit 0 and confirmed push. Full and light CLI probes waited
with spare slots and healthy memory, then ran after the gate released its
service-owned permit. Its 99-module selection differs from the historical
gate; do not attribute the timing difference causally to these changes.
The live simulator planner refused this caller; simulator priority remains
covered by the separate native reservation/boot-submission proof.

## Revisit when

Revisit import seams when profiling identifies another repeated unused graph,
or upstream Pi offers stable narrow exports. Consider isolation changes only
with an independently approved contract preserving every existing isolation
guarantee. Revisit gate scheduling if ordinary work starves, remote execution
needs equivalent priority, or measured resource usage supports more concurrency.
