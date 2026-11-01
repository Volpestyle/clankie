# ADR 0327: Effect pilot on fleet observation

Status: Accepted as a pilot, 2026-11-01. Whether Effect goes further in the
service is the owner's call, made from the measurements below (ADR 0325 named
this pilot).

## Context

`packages/real-run` already uses Effect 4.0.7. The service does not. ADR 0325
picked fleet observation as the ground for one trial, because it is where the
service juggles many concurrent reads that each may fail, time out or be
cancelled, and where hand-written `Promise.all`, `try/finally` and
`AbortSignal` checks pile up.

The seam chosen is the source reads inside `readFleet`
(`apps/clankie/src/captain/herdr-census.ts`): the local Herdr census and one
snapshot per linked fleet, read together. Each source reports a pending
diagnostic when it starts and how it ended when it settles, and each fails
soft on its own, so one down machine hides nobody else (ADR 0184). The seam is
small, outside the captain, and read by every roster poll.

## Decision

- The source reads in `readFleet` are written with Effect: `observeSource`
  opens a source's pending diagnostic when it starts and closes it from the
  source's exit (`Effect.onExit`), `Effect.forEach` reads the linked fleets
  concurrently, `Effect.orElseSucceed` keeps each one's fail-soft empty
  result, and `Effect.runPromise` returns the same `Promise<ObservedFleet>`.
  The exported API, the results and the diagnostics' order are unchanged.
- The service imports Effect modules by path (`effect/Effect`, `effect/Exit`),
  never the package root, because the root re-exports the whole library.
- Nothing else in the service moves to Effect under this ADR.

## What the pilot measured

| Measure                                                    | Promises       | Effect             |
| ---------------------------------------------------------- | -------------- | ------------------ |
| Lines for the seam                                         | 45             | 62 (with helper)   |
| Diagnostics order, three fleets with one down, one garbled | same           | same               |
| Existing fleet observation tests (60 pass, 4 need Herdr)   | pass           | pass               |
| One `readFleet` over three in-memory fleets                | about 11–20 µs | about 27–34 µs     |
| Cold import in development (`effect` root)                 | none           | about 210 ms       |
| Cold import in development (`effect/Effect` + `Exit`)      | none           | about 63 ms        |
| Release bundle growth (minified, gzip)                     | none           | about 33 KB, 12 KB |

What it bought: the pending diagnostic is tied to the source's exit, so it
closes on success, failure and interruption without a hand-written
`try/finally`; per-source isolation is a combinator instead of a nested
`try/catch` per fleet; and the seam is ready for a per-source timeout or
cancellation in one line each, which the Promise version would need an
`AbortController` and timer for.

What it cost: a second error model. A throw inside `Effect.map` is a defect,
not a failure, so the post-read parsing had to move into `Effect.try` to stay
fail-soft; the Promise version got that for free from its `try`. Readers need
to know Effect's vocabulary (`suspend`, `onExit`, `orElseSucceed`). The
runtime cost per read is microseconds against Herdr reads that take
milliseconds, and the bundle cost is small, but development startup pays
tens of milliseconds the first time the module loads.

## Consequences

- The pilot is behaviour-neutral and can be reverted alone.
- Going further would pay off where the service hand-rolls cancellation and
  timeouts (Codex session recovery's `AbortSignal` checks, the census
  breaker, bounded fleet reads) more than in plain concurrent reads like this
  one.
- Real-Herdr proof of the seam runs on the Mac, where `hc` and Herdr exist;
  the cloud checkout skips those tests.
