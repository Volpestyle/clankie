# Delegation protocol

## Worker brief

Every assignment carries:

```text
mission/task/worker-run identities
role and bounded objective
authoritative issue plus full-thread instruction
dependencies and expected inputs
write scope and read-only scope
success criteria and unchanged acceptance checks
verification commands and evidence requirements
budget, risk, stop guards, and escalation route
result/sentinel locations for pane-hosted workers
```

Parallel writers must be path-disjoint. If one task consumes another task's output, encode the dependency and sequence them. Shared manifests, lockfiles, generated artifacts, and repo-wide gates have one declared owner.

## Durable run receipt

A pane-hosted run may keep transport receipts under `${CLANKIE_HERDR_RUN_ROOT:-$HOME/.clankie/herdr-runs}/<run-id>/`:

```text
manifest.json
workers/<slug>/prompt.md
workers/<slug>/result.md
workers/<slug>/DONE
workers/<slug>/BLOCKED
```

`manifest.json` records what was spawned: durable worker name, task and worker-run identities, cwd, harness, command vocabulary, and timestamps. It does not replace the tracker DAG or event store. Store pane IDs only as diagnostic spawn-time metadata because they are session-local and may compact.

## Goal arming

Wait until a pane-hosted harness is ready, apply supported `/model` and `/effort` configuration, then submit:

```text
/goal <bounded objective>; done when <success criteria and evidence>
```

Arming may happen at the spawn seam or immediately afterward through the same pane command a human uses. Record whether the goal was armed, unsupported, or failed. Unsupported harnesses keep their normal task loop; never emulate `/goal` with a hidden captain-only API. Adapter-hosted workers receive the equivalent task lifecycle through their typed adapter.

## Sentinels and harvest

For pane-hosted fallback workers:

- `DONE` means `result.md` is ready for harvest.
- `BLOCKED` means `result.md` states the exact missing input or stop guard.
- both files at once are an invalid receipt that requires diagnosis.
- no sentinel plus a settled pane is not completion; inspect and request the missing receipt or classify the run from semantic events.

Harvest reads the receipt, validates its claimed commands/artifacts against current state, and records the corresponding semantic outcome. Tier-0/1 events remain the status winner even when a sentinel or pane heuristic disagrees. Never wait on printed completion strings: a prompt echo can create a false match.

Watch for completion on the sentinel FILES as the primary signal (a low-frequency
existence poll of `DONE`/`BLOCKED` is cheap and durable), with pane-status waits as
secondary. `herdr wait agent-status <pane> --status done` can return "timed out
waiting for agent status change" long before its `--timeout`, and a goal-armed pane
that flips status between watcher arm and delivery is missed entirely — the sentinel
file is the receipt that cannot race.

## Resume

After captain restart:

1. Load the mission snapshot and replayed status explanations from the event store.
2. Read the run manifest and each worker result/sentinel receipt.
3. Correlate by mission, task, and worker-run IDs.
4. Re-resolve a live pane by durable worker name only when steering or diagnosis is needed.
5. Re-arm monitoring for active work and surface receipt/event disagreements instead of guessing.

## Cleanup authority

Cleanup is permitted only for workers created by the current captain or recorded in the run being harvested. A task completion does not automatically end a warm worker's lifecycle. Before retirement, confirm that evidence is harvested, verification and tracker reconciliation are complete, no question remains, and the ownership ledger has no next assignment. Preserve run receipts when doctrine or an unresolved failure requires later audit.
