---
name: debug-failure
description: Use when a test, verifier, provider session, terminal, integration, or policy check failed and the failure must be reproduced and repaired safely.
---

# Debug a failure

1. Preserve the original failure output and environment identifiers. For the
   launcher-supervised local services (captain-eve, control-plane,
   discord-bridge, activity), that output lives under
   `${XDG_STATE_HOME:-~/.local/state}/clankie/`: `<service-id>.log` per
   service, plus the bridge's `discord-live-receipts.jsonl` for the semantic
   record of what Discord actions actually happened
   (see `docs/11-development.md`).
2. Reproduce with the smallest exact command.
3. Classify: product defect, test defect, environment, dependency, provider, orchestration, policy, race, or flaky check.
4. Identify the first causal divergence, not the last visible symptom.
5. Make the smallest fix inside the assigned scope.
6. Rerun the exact failed check unchanged, then adjacent regression checks.
7. Add or update regression coverage inside the task when it preserves the frozen acceptance
   contract. If the fix requires weakening or semantically changing an acceptance test, evaluator,
   fixture, or doctrine rule, stop and request a separately reviewed task.
8. Report root cause, repair, evidence, residual risk, and whether retry/replacement logic should change.

Use `references/failure-taxonomy.md` for structured diagnosis.
