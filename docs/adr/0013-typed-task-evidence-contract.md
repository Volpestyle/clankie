# ADR 0013: Typed task roles, evidence contracts, and planned actions

Status: accepted.

## Context

The mission model treats a task as a bounded unit with an operational role and an evidence contract. Planning also needs reviewable estimates and advance visibility into privileged actions. Keeping those fields only in prose or an untyped metadata bag prevents deterministic validation and lets worker prompts silently omit them.

Two alternatives do not meet the control-plane contract:

- deriving role from task kind conflates the work category used for routing with the accountable role used for separation of duties;
- recording privileged actions only when execution begins prevents plan review from seeing the intended side effects.

## Decision

`TaskSpec` requires an explicit role and at least one evidence requirement. Changed-line, duration, and cost estimates remain optional because not every task can estimate all three honestly.

`MissionPlan` records assumptions, risks, human decisions, and anticipated privileged actions. A planned action names intent and resource only; it grants no capability and does not predict the policy result. The policy engine remains the sole authority for allow, deny, and approval decisions at execution time.

Worker adapters include the role and evidence requirements in the task prompt. This keeps the typed plan, assignment, and returned evidence connected end to end.

## Consequences

- Invalid plans fail before scheduling when a task lacks role/evidence or a planned action references an unknown task.
- Evaluators can measure role fit and evidence completeness from structured state.
- Existing plan producers must populate the required task fields.
- Cost and duration estimates remain advisory inputs to doctrine and evaluation, not enforcement by themselves.
