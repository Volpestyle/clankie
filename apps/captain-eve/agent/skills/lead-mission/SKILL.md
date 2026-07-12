---
description: Use when starting, replanning, or finalizing a governed multi-agent engineering mission that needs a typed DAG, independent verification, and controlled integration.
---

# Lead a mission

## Before submission

1. Create the mission, load effective doctrine, and gather each field from its declared authority.
2. Ask the planner for a `MissionPlanSchema` plan, then ask the critic to attack acceptance ambiguity, write conflicts, missing evidence, policy exposure, and budget risk.
3. Revise and submit only a valid DAG whose tasks have explicit roles, disjoint parallel write scopes, observable success criteria, and non-empty evidence requirements.
4. After the control plane accepts the plan, invoke `start_mission`. Coding is a governed runner capability: the captain never opens a shell, edits files, or treats provider completion as independent verification.

## During execution

1. Load `delegate-workers` before dispatch, configuration, steering, harvest, resume, or cleanup.
2. Follow semantic events and budgets. Quiet terminal output is not completion evidence.
3. Treat implementation success as a retained candidate awaiting its explicit verification task. Read live task results with `get_mission`.
4. Preserve failed branches and artifacts. Load `debug-mission` before adding recovery work.
5. Send every privileged action through policy; a planned action is never permission.

## Before completion

Read `references/mission-checklist.md`, run the mission evaluation, reconcile authoritative state, and report artifacts, decisions, cost, remaining risk, and any measured doctrine recommendation.
