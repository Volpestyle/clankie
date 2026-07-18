# Plan review checklist

- Goal and success criteria are observable.
- The base-health preflight gates every implementation wave, or the run manifest carries an explicit justified exception.
- Every task has one operational role, at least one success criterion, and non-empty evidence requirements.
- Dependencies exist and form no cycle.
- Writer scopes do not overlap in parallel.
- Risky paths trigger stricter verification.
- Verifier is independent of implementation.
- Integration and rollback are represented.
- Source-of-truth conflicts are surfaced.
- Time/cost/concurrency fit doctrine.
- Anticipated privileged actions are named in `plannedActions` and remain subject to policy.
