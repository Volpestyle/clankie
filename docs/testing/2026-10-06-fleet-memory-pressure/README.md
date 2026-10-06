# Darwin fleet memory pressure — VUH-1760

[VUH-1760](https://linear.app/vuhlp/issue/VUH-1760) follow-up to `754c225c`.
Branch: `odo/vuh-1760-memory-pressure`, based on `origin/main` at `47cbe333`.

The earlier page-queue sum still understated the macOS pressure metric and
launched `vm_stat` on every sample. The governor now uses physical memory times
`kern.memorystatus_level`, the compressor-aware percentage also reported by
`memory_pressure -Q`. The existing Python native boundary reads both values
directly with `sysctlbyname`. Apple's [XNU source](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_memorystatus.c)
declares this kernel percentage as a read-only integer sysctl.

One in-flight read and a one-second successful-observation cache are shared across
pressure samplers in each process. The cache uses monotonic time. An expired
healthy value cannot authorize admission after a failed or invalid refresh; the
existing `probe-unavailable` refusal applies. Zero percent is a valid low-memory
observation. No process identity or lease authority comes from this cache.
Linux's accepted `MemAvailable` behavior remains unchanged.

## Live comparison

Paired real observations from the Darwin integration test on James's Mac at
**2026-10-06 23:40:18 UTC**, retained in [live.json](live.json):

| Observation                                       | Value                           |
| ------------------------------------------------- | ------------------------------- |
| Physical RAM                                      | 137438953472 bytes (131072 MiB) |
| Candidate governor available memory               | 110100.48 MiB                   |
| Candidate governor percentage                     | 84%                             |
| `memory_pressure -Q` percentage, before and after | 84%                             |
| Difference                                        | 0 percentage points             |

```text
The system has 137438953472 (8388608 pages with a page size of 16384).
System-wide memory free percentage: 84%
```

The first sample and twelve repeated samplers launched **one** native memory
read. After a 1.1-second wait, a fresh read returned 83% (108789.76 MiB), proving
refresh rather than a permanent cache. Two reads total. This uses the changed
source directly; installed runtime acceptance remains unproved.

## Verification

**28 tests passed** across these three scoped integration files, run through
`clankie heavy` on 2026-10-06 (38.44 seconds):

```sh
pnpm exec vitest run --config vitest.config.ts \
  packages/fleet-resources/test/darwin-pressure.integration.test.ts \
  packages/fleet-resources/test/probe-failure.integration.test.ts \
  packages/fleet-resources/test/heavy-process.integration.test.ts
```

The three Darwin cases establish:

- Darwin integration: compare the real kernel/native sampler with
  `memory_pressure -Q` before and after; twelve repeated sampler instances must
  reuse one native read, then refresh after expiry.
- Real governor admission with an isolated zero minimum succeeds, then a minimum
  above physical RAM refuses for memory. This exercises the real Darwin source
  and admission path without inducing physical memory pressure.
- Corrupt a real native reply after expiry; refuse instead of reusing the earlier
  healthy value, then recover after the corruption is removed.

Also passed through `clankie heavy`: fleet-resources typecheck, scoped
`oxlint --deny-warnings`, scoped `oxfmt --check`, and documentation links
(471 Markdown files). The first local check script stopped after the passing
tests because it was edited while running; the remaining checks passed from a
separate script. Local gate logs are in `.local/fleet-memory-pressure/`.

Full gate and runtime acceptance belong to integration. Linux was not exercised
on this Darwin host, and physical low-memory stress was not induced. No deploy,
simulator, release or eval was run.
