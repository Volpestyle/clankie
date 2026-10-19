# Native proof helper start under load (VUH-2496)

Every native caller observation (worker fixture reads, fleet admissions, project
membership cwd reads) goes through one long-lived compiled helper
(`apps/clankie/src/native-process-transport.ts`). Its active request had a fixed
1 s timeout, and the first request on a fresh helper also starts it. Measured on
James's 18-core Mac on 2026-10-19 while another seat held a booted iOS 27
simulator.

## Measurements

[`latency.mjs`](latency.mjs) times the real helper over its `--serve` pipe, with
no bound. A "fresh copy" is a byte-identical copy of the built helper at a new
path that has never been executed.

| Case                                       | load1 |   n |        p50 | Slowest                     |
| ------------------------------------------ | ----: | --: | ---------: | --------------------------- |
| Warm socket proof (full kernel census)     | 26–30 | 190 | 4.5–4.8 ms | 13.4 ms                     |
| Warm `--birth`                             | 26–30 |  50 |     0.0 ms | 0.2 ms                      |
| Cold start, helper already executed before | 12–27 |  90 |     6–7 ms | 21 ms                       |
| Cold start, fresh copy, 4 at once          | 13–15 |  60 |      61 ms | 1,455–1,458 ms (4 together) |
| Cold start, fresh copy, one at a time      | 17–29 |   8 |     274 ms | 2,092 ms; 3 of 8 over 1 s   |

Only the first exec of a binary macOS has not yet seen is slow; later starts of
the same file take milliseconds even under load. That first exec happens after
every install or upgrade, every `build-fleet-proof` in a fresh worktree, and in
tests that copy the helper, such as `fixture-admission-boundary`. Warm proofs
never approached the bound. True idle was not available on the shared machine;
the lowest load sampled was about 6.

## Product-path before and after

[`probe.mts`](probe.mts) makes one `observeSocketProcess` call (the exact
observation behind worker reads and fleet admissions) through a fresh transport
and a fresh helper copy, four processes at a time. Rounds alternated between the
old and new transport source so both ran at the same load (load1 7.3–7.9, the
`apps/clankie` suite looping under `clankie heavy` plus the simulator).

| Transport                         | First observations | Unavailable (`timeout`) | Slowest admitted                     |
| --------------------------------- | -----------------: | ----------------------: | ------------------------------------ |
| Before: 1 s for every request     |                160 |                      12 | 235 ms; every miss at 1,003–1,006 ms |
| After: 10 s first reply, then 1 s |                160 |                       0 | 2,226 ms                             |

In each refused case, a second observation from the same caller was admitted at
once. An earlier "before" run at load1 14–16 gave 7 of 100 unavailable.

The gate tests named in VUH-2490 (`fixture-admission-boundary`,
`fixture-admission-corrective`, `fleet-project-membership`) were also run four
times each on old and new source, with their VUH-2490 resend loops temporarily
counted. At load1 4–9 they resent 0 times either way (74 of 74 tests passed in
all 8 runs). At that load they did not reproduce the miss, so they are not
before/after evidence.

## Decision

A fresh helper's first reply gets a 10 s bound, matching the cold-start
allowance `packages/fleet-resources` already gives its Python helper. After that
reply, each proof keeps the 1 s stall bound. A helper that never answers still
times out, is killed and refuses (`timeout`). Its queued callers move to a
successor, whose own first reply gets the startup bound. Identity and session
fences are unchanged; only the transport timer changed. ADR 0217 records the
amendment.
