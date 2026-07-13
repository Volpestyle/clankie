---
name: clankie-lead
description: Delegate, supervise, harvest, resume, and retire visible Clankie workers through the operator command surface. Use when the designated lead or captain runs a multi-worker mission, arms pane-hosted workers with /goal, steers active workers, or reconstructs a staged run from durable evidence.
---

# Lead staged workers

Use the same worker-control vocabulary available to a human operator. Never invent a captain-only spawn, steering, status, cleanup, or approval API.

Follow the repository's [Captain worker control](../../../docs/05-worker-and-terminal-runtime.md#captain-worker-control-operator-parity) contract and [ADR 0018](../../../docs/adr/0018-captain-worker-control-parity.md) for operator parity; use [ADR 0017](../../../docs/adr/0017-self-development-operating-model.md) to identify who occupies the lead seat.

This protocol is adapted from the pinned v1 `clankie-lead` snapshot `04734df9`. It is self-contained in v2; never load scripts or instructions from the deprecated v1 checkout at runtime.

## Establish authority

1. Act only as the mission's designated lead or captain. During scaffolding an external harness may occupy that seat; after the M2 gate the Eve captain leads supervised self-development.
2. Treat the tracker as product-intent and acceptance authority, the mission engine as the task/DAG authority, and the event store as active-execution authority. A pane, manifest, or sentinel is never a second task ledger.
3. During the scaffolding protocol in `docs/11-development.md`, keep issue claim, assignment, status, signed worker reports, and evidence current in the tracker. Workers report; the lead owns adjudication and transitions.
4. Read `references/delegation-protocol.md` before the first dispatch in a run. It defines the brief, run receipt, sentinel, harvest, resume, and cleanup contracts.
5. Delegate only accepted plan tasks with explicit dependencies and non-overlapping concurrent write scopes. Preserve independent verification.

## Dispatch through operator parity

1. Create the worker assignment in the mission engine before starting a process or pane. Record the mission, task, worker-run, correlation, doctrine, and profile identities.
2. Give the worker a bounded brief containing objective, authoritative context, role, dependencies, write/read scope, success criteria, evidence, verification commands, budget, and stop conditions. Point tracker-capable workers at the issue and full comment thread instead of copying stale product context.
3. During scaffolding, pane-hosted workers run in Herdr. Spawn them with `herdr pane split` + `herdr pane run` (or the Clanky spawn surface when available), confirm identity with `herdr pane list`, and wait on completion with `clanky watch` / `herdr wait` rather than polling pane text. Never substitute a harness's built-in delegation backend (for example Codex cloud agents) for mission workers: those runs are invisible to the pane transport, mission accounting, and the harvest contracts in this protocol, and a lead waiting on them starves.
4. For a pane-hosted harness, use the pane's normal operator commands:
   - `/model <model>` and `/effort <level>` for supported configuration;
   - plain steering text for bounded course corrections;
   - `/goal <task and definition of done>` at spawn readiness or immediately after spawn to arm the native completion loop. Goal conditions are hard-capped at 4000 characters: keep the condition a short pointer (prompt path + DONE/BLOCKED sentinel check) with the full criteria in the worker's `prompt.md`. Verify the arm succeeded — a rejected arm leaves the worker silently idle with no completion signal, and every send (goal or steering) is delivered only when the pane's status flips to `working`.
5. For an adapter-hosted worker, use the same vocabulary through its typed protocol mapping. The mission task lifecycle is its `/goal` equivalent; do not inject terminal commands into a protocol-native session.
6. Attribute every captain input. A human control lease pauses automated captain input.

Operator parity covers configuration and steering only. Never send approval answers, credentials, policy overrides, merge commands, deployment permission, or other privileged decisions into a worker pane. Request privileged action through policy and wait for an authenticated human approval surface.

## Supervise semantic state

1. Monitor the mission snapshot and event store. Prefer Tier-0 protocol facts, then Tier-1 runner leases and exits. Tier-2 pane heuristics may fill `unknown` or raise attention but never override Tier 0/1.
2. Treat `worker.turn.settled` as an idle turn, not terminal completion. Only terminal worker settlement ends the worker run.
3. Treat `waiting_user` as a question to relay or an approval request to route. Never answer an approval by steering the pane.
4. Use pane reads only for diagnosis or deliberate steering. Terminal silence, an idle heuristic, `DONE`, or a model's success claim is not verification.
5. On blockage, preserve evidence and either answer an ordinary bounded question, replan, or escalate. Do not widen scope implicitly.
6. A freeze order carries an explicit scope and lift condition, and the lift is an event, not an inference: when the landing that motivated a freeze completes, broadcast the lift to every party that received the freeze. A worker honoring a stale freeze is indistinguishable from a stalled worker unless its receipt says why it parked.
7. When a candidate is superseded or a decisive counterexample lands, stop its in-flight verifiers immediately and record a partial receipt; verification spend on a dead candidate is waste, not rigor.

## Harvest and resume

1. Harvest the worker result, exact commands and exit codes, artifacts, risks, assumptions, tracker writes, and final diff/commit identity.
2. Reconcile pane-hosted `DONE` or `BLOCKED` sentinels into semantic mission events. Sentinels are durable completion receipts for that transport; the event store remains authoritative.
3. Independently review and verify the result before accepting it. A finished turn or sentinel means only that the worker claims its task ended.
4. Resume after captain restart from the mission snapshot and event log, then correlate any run manifest, result, and sentinel receipts. Re-resolve live panes by durable worker identity; never trust stored pane IDs.

## Retire safely

At each task boundary choose explicitly: re-arm the worker with a new `/goal`, keep it idle with ownership recorded, or retire it. Close only panes and run receipts created by this captain or listed in the run being harvested. Retire only after results are harvested, tracker state is reconciled, and no next assignment or unresolved blocker remains. Never clean up an unrelated pane merely because it appears idle, done, or stale.
