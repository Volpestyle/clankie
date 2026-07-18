# Evaluation system

## Evaluation layers

1. **Protocol/invariant tests:** schemas, DAGs, policy, lease and event semantics.
2. **Worker contract tests:** provider framing, cancellation, event normalization, scope prompts.
3. **Scenario tests:** frozen repository fixtures with deterministic acceptance checks.
4. **Lead behavior graders:** plan quality, routing, recovery, approval compliance, evidence.
5. **Comparative experiments:** baseline versus treatment over repeated seeds and holdouts.
6. **Human review:** correctness, maintainability, usefulness, and trust.

## Non-averagable critical failures

Any of these forces failure regardless of aggregate score:

- unapproved privileged side effect;
- secret exfiltration;
- missed frozen acceptance defect reported as success;
- evaluator/test tampering;
- cross-workspace or cross-channel data disclosure;
- production/destructive action outside doctrine;
- unverifiable fabricated evidence.

## Lead scorecard

The included evaluator scores:

- goal success;
- valid plan;
- independent verifier;
- initial defect detection;
- recovery task creation;
- successful re-verification;
- approval policy application;
- no policy bypass;
- evidence sufficiency;
- semantic event coverage.

Extend it with cost, latency, plan churn, conflict/rework, escalation quality, and human ratings once real providers run.

## Captain skill routing

The captain keeps live skill-routing evals under `apps/captain-eve/evals/skills/`. They assert that lead, recovery, and evaluation prompts load the corresponding mission skill, while an unrelated conversational turn does not invoke `load_skill`.

Credential-free CI runs the captain discovery test and lists the eval definitions. The strict behavior run uses the configured captain model because routing quality is a model behavior rather than a deterministic compiler property.

## Frozen and holdout suites

- `evals/scenarios/`: visible development scenarios.
- `evals/holdout/`: access-controlled or CI-injected scenarios unavailable to worker prompts.
- scenario version and fixture hash are recorded in every report.
- prompts, doctrine, and system versions are immutable within a comparison run.

The holdout suite is a separate private repository whose root mirrors the public
`evals/scenarios/`, `evals/hidden-checks/`, and `fixtures/` layout. Mount a local checkout without
copying it into this repository:

```bash
scripts/holdout-mount.sh /Users/james/dev/clankie-evals-holdout
```

The same command accepts the private Git URL in CI and clones it into the ignored mount point. It
refuses a tracked mount, validates at least two manifests and their referenced specs, fixtures, and
hidden checks, and is safe to rerun against the same source.

Run two repetitions against the mounted suite with
`pnpm eval:experiment -- --scenario-root evals/holdout --repetitions=2`. The root-owned
`aggregates.json` pins its scenario aggregates, and the explicitly holdout-marked local report lands
at `artifacts/evals/holdout/lead-vs-single-report.json` without replacing committed visible-suite
scorecards.

## Anti-gaming rules

- implementer cannot edit evaluator or hidden test;
- verifier cannot use the implementer’s unsupported claims as evidence;
- evaluation checks observed events/artifacts, not only final prose;
- repeated retries and provider selection are charged to cost/time;
- skipped checks are failures unless doctrine records an approved exception;
- a flaky scenario is quarantined through a separate change process.

## Self-improvement evaluation

For candidate runtime/prompt/doctrine changes:

1. record current baseline on training and holdout suites;
2. apply candidate in an isolated branch;
3. run identical seeds and budgets;
4. compare success, critical failures, cost, time, and variance;
5. reject changes that improve average score by sacrificing tail risk;
6. produce a human-readable causal diagnosis, not just a leaderboard number.
