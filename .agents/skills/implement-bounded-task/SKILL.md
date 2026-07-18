---
description: Use when implementing one assigned code, configuration, documentation, or design task inside an explicit write scope.
---

# Implement a bounded task

- Confirm the base revision, task objective, write scope, dependencies, and acceptance criteria.
- Inspect existing patterns and tests before editing.
- Make the smallest coherent change that satisfies the contract.
- Use a broader behavior-preserving scope only when the tracker and task contract invoke the
  [sanctioned structural refactor](../../../docs/04-doctrine.md#sanctioned-structural-refactor)
  class. Record the bounded size, structural intent, and why the exact unchanged checks cover
  every affected boundary. Keep behavior and semantic test changes in separate tasks; report
  mechanical test relocation/import updates separately for assertion-preservation review. Amend
  or replan before integrating a diff that exceeds the recorded size. Obtain verifier and reviewer
  confirmation of check coverage plus reviewer sign-off on the structural intent. The doctrine
  section is authoritative.
- Do not modify files outside scope; request scope expansion instead.
- Do not weaken, delete, skip, or replace acceptance tests to make the change pass.
- Run a narrow reproducer first, then required typecheck/lint/unit/integration checks.
- Separate generated/lockfile churn from authored changes.
- Finish with exact files changed, commands, exit results, artifacts, risks, and assumptions.
- Never merge, deploy, publish, close tracker work, or change doctrine from this role.
