---
description: Use when implementing one assigned code, configuration, documentation, or design task inside an explicit write scope.
---

# Implement a bounded task

- Confirm the base revision, task objective, write scope, dependencies, and acceptance criteria.
- Inspect existing patterns and tests before editing.
- Make the smallest coherent change that satisfies the contract.
- Do not modify files outside scope; request scope expansion instead.
- Do not weaken, delete, skip, or replace acceptance tests to make the change pass.
- Run a narrow reproducer first, then required typecheck/lint/unit/integration checks.
- Separate generated/lockfile churn from authored changes.
- Finish with exact files changed, commands, exit results, artifacts, risks, and assumptions.
- Never merge, deploy, publish, close tracker work, or change doctrine from this role.
