---
description: Use when turning a product goal, issue, incident, or self-improvement idea into a governed mission plan and task dependency graph.
---

# Plan a mission

Use `MissionPlanSchema` in `packages/protocol` as the field-level contract.

1. Identify the authoritative source for goal, acceptance criteria, implementation state, design, and current execution.
2. Restate the outcome and list unresolved conflicts or assumptions.
3. Add a base-health preflight dependency before every implementation wave: the target commit must pass `pnpm typecheck`, `pnpm test`, and `pnpm arch:check` in a clean detached worktree (use `../clankie-lead/references/preflight-base.sh`). Red base means fix-or-rebase first; only an explicit exception with rationale in the run manifest may waive the gate.
4. Decompose into tasks that each have one operational role, bounded objective, dependencies, write scope, risk, success criteria, and non-empty evidence requirements.
5. Route context/research/critique to lightweight subagents; route stateful write work to isolated runner workers.
6. Avoid concurrent overlapping write scopes.
7. Include independent verification and integration explicitly; the implementer cannot certify itself.
8. Add changed-line, duration, and cost estimates where they improve budget or review decisions.
9. Record every anticipated privileged action in `plannedActions`; the policy engine, not the plan, decides whether it is allowed or needs approval.
10. Validate the DAG and budget before requesting execution approval.

Return the typed plan with assumptions, risks, and the smallest human decisions still required. Use `references/plan-review.md` before submission.
