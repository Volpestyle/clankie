# ADR 0330: Effect rolls out module by module

Status: Accepted, 2026-11-01. The owner chose a gradual rollout after the
pilot (ADR 0327). Extends ADR 0325.

## Context

ADR 0327 tried Effect on fleet observation's source reads and measured what it
bought and cost. It bought errors written into a function's type, so the
compiler names a failure nobody handled, and cleanup of timers, connections
and child work tied to how the work ended. It cost a second error model: where
Effect code meets plain `async` code, a throw and a typed failure have to be
translated, and that seam is where new bugs creep in. Both grow with how much
of the service uses it.

Agents write the service and the compiler checks it, so the vocabulary cost
falls on the compiler more than on readers.

## Decision

- Effect goes further in the service, gradually, one module at a time. A
  module moves when the captain split (ADR 0325) or the core/extension work
  (ADR 0328) already touches it, starting where the service hand-rolls
  cancellation and timeouts: Codex session recovery's `AbortSignal` checks,
  the census breaker and bounded fleet reads.
- A module is converted whole, never half. Inside it, failures are typed and
  cleanup is scoped; its exported functions keep their existing Promise or
  plain signatures until their callers move too.
- The seam between Effect and plain `async` is small and explicit: one
  `Effect.runPromise` (or `Effect.tryPromise`) at the module's edge, never
  scattered through it. A throw inside a callback is a defect, so parsing and
  other code that may throw goes through `Effect.try`, as the pilot learned.
- Each move is behaviour-neutral: the same results, diagnostics and order,
  proven by the module's existing tests and a real run where one exists.
- Modules import Effect by path (`effect/Effect`, `effect/Exit`), never the
  package root (ADR 0327).

## Consequences

- Some modules use Effect and some do not for as long as the rollout runs;
  the explicit seams keep that mix readable.
- A module that is not touched for other reasons stays as it is. The rollout
  has no deadline of its own.
- The pilot's costs (tens of milliseconds of first import in development,
  about 12 KB gzip in the release) are paid once and do not grow per module.
