---
description: Use when dispatching, configuring, steering, harvesting, resuming, or retiring mission workers through the shared operator command surface, including arming pane-hosted workers with /goal.
---

# Delegate workers

## Before dispatch

1. Load `lead-mission` and dispatch only an accepted plan task with explicit dependencies, scope, success criteria, evidence, and budget.
2. Keep the tracker as intent authority and durable reporting ledger, the mission engine as task/DAG authority, and the event store as active-execution authority. A pane manifest or sentinel is only a transport receipt.
3. Create a complete worker brief: mission/task/worker-run identities, issue and full-thread pointer, role, objective, inputs, write/read scope, checks, evidence, stop guards, and escalation route.

## Use the operator vocabulary

Start eligible mission work with `start_mission`. Configure or steer an active pane-hosted worker through `steer_worker` using exactly the commands a human operator sees: `/model`, `/effort`, plain steering text, and `/goal <task and definition of done>`. Arm `/goal` at spawn readiness or immediately afterward when the harness supports it.

Adapter-hosted workers receive the same vocabulary through typed protocol methods; their accepted task lifecycle is the `/goal` equivalent. Never create a private captain control path.

Parity covers configuration and steering, not authority. Never send approval answers, credentials, policy overrides, merge/deploy permission, or other privileged decisions into a pane. Request policy decisions through the control plane and wait for an authenticated human approval surface.

## Supervise and harvest

1. Read live state with `get_mission` and follow semantic status events. Tier 0 wins over Tier 1, and Tier 2 only fills `unknown` or raises attention.
2. Treat `worker.turn.settled` as idle, not terminal. Only worker settlement ends the worker run.
3. Relay ordinary `waiting_user` questions; route approval requests instead of answering them through `steer_worker`.
4. Harvest results, exact checks, artifacts, risks, tracker writes, and branch/commit identity. Reconcile pane `DONE`/`BLOCKED` receipts into mission events; never treat terminal output or a sentinel as independent verification.
5. After harvest choose explicitly to re-arm with a new `/goal`, retain the worker idle with ownership recorded, or retire it. Clean up only workers owned by this mission and only after evidence and tracker state are reconciled.
6. On restart, reconstruct from the mission snapshot and event log before consulting manifests or sentinels. Resolve panes by durable worker identity, never a stored pane ID.
