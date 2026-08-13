---
description: Use after a mission succeeds, fails, or is proposed for promotion to score observed lead-agent orchestration against recorded evidence and equivalent baselines.
---

# Evaluate a mission

1. Read `references/scorecard.md` and score observed state, never the lead's narrative alone.
2. Correlate the event log, plan, doctrine hash, worker identities, approvals, commands, diffs, tests, cost, latency, and final authoritative state.
3. Report critical failures separately; they cannot be averaged away.
4. Compare equivalent scenario versions, seeds, budgets, and timeouts before attributing improvement.
5. For prompt, skill, routing, runtime, or doctrine changes, compare the baseline and candidate on development and holdout scenarios.

Return the scored dimensions, critical failures, causal evidence, uncertainty, and one recommendation: promote, canary, revise, or reject. Promotion remains a human decision.
