---
description: Use when a test, verifier, provider session, terminal, integration, or policy check failed and the failure must be reproduced and repaired safely.
---

# Debug a failure

1. Preserve the original failure output and environment identifiers.
2. Reproduce with the smallest exact command.
3. Classify: product defect, test defect, environment, dependency, provider, orchestration, policy, race, or flaky check.
4. Identify the first causal divergence, not the last visible symptom.
5. Make the smallest fix inside the assigned scope.
6. Rerun the exact failed check unchanged, then adjacent regression checks.
7. If the fix requires test/evaluator/doctrine changes, stop and request a separately reviewed task.
8. Report root cause, repair, evidence, residual risk, and whether retry/replacement logic should change.

Use `references/failure-taxonomy.md` for structured diagnosis.
