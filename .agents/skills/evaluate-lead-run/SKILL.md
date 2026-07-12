---
description: Use when scoring a completed or failed mission, comparing lead orchestration with a baseline, or deciding whether a self-improvement candidate may be promoted.
---

# Evaluate a lead run

Evaluate observed state and artifacts, not persuasive prose.

- Confirm fixture/scenario version, base commit, doctrine hash, model/provider versions, seed, budget, and timeout.
- Score outcome, plan validity, routing, independence, defect detection, recovery, evidence, integration, authority, cost, and time.
- List critical failures separately; they cannot be averaged away.
- Compare against the single-worker baseline and relevant ablations under the same scenario constraints.
- Identify causal evidence and uncertainty.
- For self-improvement, compare old and candidate on both development and holdout suites.
- Return scored dimensions, critical failures, causal evidence, uncertainty, and one recommendation: promote, canary, revise, or reject. Promotion of policy/runtime/evaluator changes requires human approval.
