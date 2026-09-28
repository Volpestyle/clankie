---
name: perf-review
description: >-
  Performance-focused code review. First checks the app can be observed — that profiling,
  metrics, tracing, and perf budgets exist to measure and catch regressions — then audits
  the code for optimization conventions that keep UI/UX smooth and backends fast (deep
  React render trees, N+1 queries, blocked main threads, etc.). Trigger with /perf-review,
  optionally scoped to a path, surface, or symptom.
---

# perf-review

Review code for performance along two axes, in this order:

1. **Can you observe it?** You can't fix what you can't see. Before judging any code as
   slow, check whether the app is *instrumented* to prove it — profilers wired up, metrics
   emitted, traces propagated, perf budgets defined, regressions caught in CI. Missing
   observability is itself a finding, often the highest-leverage one.
2. **Is it optimized?** With the means to measure in place, audit the code against the
   performance conventions for its stack — rendering, data access, concurrency, memory,
   network, asset size — and flag anti-patterns that cost latency or smoothness.

The goal is a smooth, responsive product *and* the standing ability to keep it that way —
not a one-time micro-optimization pass. **Measure before you optimize:** never assert
something is slow, or that a change made it faster, without a number behind it. Call out
guesses as guesses.

## When to use this

- User runs `/perf-review` (optionally with a path `/perf-review src/feed`, a surface
  `/perf-review the chat screen`, or a symptom `/perf-review scroll jank on the timeline`).
- After a feature lands that touches a hot path, large list, heavy query, or animation.
- When users report lag, jank, slow loads, battery drain, or rising server latency/cost.
- Before a release or scale event, to confirm the app is observable and within budget.

## Scope

- **With an argument**, review only that path / surface / symptom. For a symptom, work
  backward from the user-visible slowness to the code on its critical path.
- **With no argument**, review the current diff (`git diff`, staged + unstaged, vs the
  base branch) for performance regressions and missing instrumentation on changed hot
  paths. If the tree is clean, ask whether to review the whole project or a specific area —
  a full-codebase perf sweep is large; confirm scope before deep work.

## Workflow

1. **Detect the stack and the hot paths.** Identify the frameworks (React/Next, Swift/
   SwiftUI, Node/Go/Rust backend, etc.) and where performance actually matters: list
   renders, app launch, navigation, the highest-traffic endpoints, large data
   transforms, animation/scroll surfaces. Perf is about hot paths — don't spend the review
   on cold code.
2. **Assess observability first.** For the hot paths in scope, check what exists to
   *measure* them (see Instrumentation checklist). Note every gap — these are findings.
3. **Establish a baseline where cheap.** If the project already has a profiler, benchmark,
   or metrics dashboard, take a reading so findings are grounded in numbers, not vibes.
   Use the stack's real tools (see checklists). Don't fabricate numbers — if you can't
   measure it in this session, say the finding is a static-analysis suspicion to verify.
4. **Audit the code for optimization anti-patterns** against the checklists below, scoped
   to the detected stack. For each candidate, trace whether it's actually on a hot path
   before flagging — an O(n²) loop over 5 items is not a finding.
5. **Rank by impact.** Order findings by expected user-visible or cost impact × confidence,
   not by how easy they are to spot. A missing index on the main query beats ten
   micro-allocations.
6. **Report** (see Output). For each finding: where, why it costs, how to confirm with a
   measurement, and the fix. Separate "proven with a number" from "suspected, verify."
7. **Optionally fix.** With `--fix`, apply the high-confidence, low-risk optimizations and
   add the missing instrumentation; leave risky or architectural changes as recommendations.
   Re-measure after fixing to prove the win — a perf fix with no before/after number is
   incomplete.

## Instrumentation & observability checklist

The prerequisite axis — can the team see and defend performance?

- **Profiling is possible** — there's a documented, working way to profile the hot path
  (React Profiler / Instruments / `pprof` / flamegraph / Chrome performance trace), not
  just "add console.time by hand."
- **Metrics exist for what matters** — latency (p50/p95/p99, not just averages),
  throughput, error rate, and saturation on key endpoints; frame rate / hitch rate /
  launch time on the client. RED (Rate, Errors, Duration) for services, Core Web Vitals
  (LCP, INP, CLS) for web.
- **Tracing propagates** — distributed traces / spans cross service and async boundaries
  so a slow request can be attributed, not guessed.
- **Perf budgets are defined and enforced** — bundle-size limits, frame budget (16ms/8ms),
  endpoint SLOs; ideally checked in CI so regressions fail the build rather than ship.
- **Regressions are caught** — benchmarks, Lighthouse CI, bundle-size diff, or load tests
  run automatically; alerting exists on the production metrics above.
- **Logs are structured and cheap** — timing logs carry context (request id, duration) and
  don't themselves dominate the hot path (no logging inside tight loops / per-frame).
- **Right altitude** — instrumentation lives at boundaries (request, render, query), is
  sampled where high-volume, and is strippable/disabled in release builds where it costs.

A finding here reads like: "The feed endpoint has no latency metric or trace — we can't
tell if it's the query or serialization that's slow. Add a span around the DB call and
emit p95 before optimizing."

## Stack calibration

The stack-specific anti-patterns (render scope, N+1 queries, main-thread work, and
the rest) are standard; the calibration a generic pass misses:

- **React** — fix render scope by lifting state down, splitting contexts, and
  memoizing the right things, not by sprinkling `memo`/`useMemo` everywhere (that
  has its own cost).
- **Backend** — sequential awaits that could be parallel, unbounded concurrency,
  and retries without backoff are the hidden costs that survive a quick read.
- **Apple platforms** — use Instruments (Time Profiler, Hangs, Animation Hitches)
  for main-thread and hitch findings; `debugging-instruments` and
  `swiftui-performance` have the depth. Over-broad `body` recomputation, missing
  stable identity in `ForEach`, and images not downsampled to display size are the
  SwiftUI findings that recur.

## Output

Group findings into the two axes, each ranked by impact:

- **Observability gaps** — what can't currently be measured, and the instrumentation to add.
- **Optimization findings** — anti-patterns on hot paths, each with: location
  (`file:line`), the cost and *who feels it* (user-visible lag / battery / server $),
  confidence (**proven** with a number vs **suspected** static finding), how to confirm
  with a measurement, and the fix.
- **Looks good** — hot paths checked that are already sound; say so rather than padding.

Lead with the single highest-leverage change. Keep it honest: if you couldn't measure,
say so and give the user the exact command/profile to run.

## Notes

- **No premature optimization.** Don't recommend complexity for cold paths or unproven
  wins. The bar for a finding is real, hot-path impact — flag the risk of over-engineering
  if you see it, too.
- **Respect repo conventions** — match the project's existing perf tooling, metrics stack,
  and idioms rather than importing new ones unasked (per the user's global rules).
- **Prefer the root-cause fix** over a band-aid (e.g. fix the over-broad state, don't paper
  over it with `memo`), and call out tech debt explicitly when the proper fix is out of scope.
- **Cross-references** — lean on the stack-specific skills for depth: `swiftui-performance`,
  `debugging-instruments` (iOS profiling), `chrome-cdp` (web DOM/CSS/perf inspection),
  `react-flow-v12`, `ios-networking` / `ios-simulator` where relevant.
