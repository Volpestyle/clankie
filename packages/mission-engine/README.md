# @clankie/mission-engine

The mission engine owns deterministic task admission, worker leasing, runtime
identity, and semantic mission events. Verification and repair are separate
control-loop stages:

```text
implementation (writer, any retries)
        |
        v
verification (read-only, independent writer identity)
        |
   failure evidence
        v
debugging (exact-check reproduction + smallest repair)
        |
        v
re-verification (independent from every writer)
```

Verification workers receive a metadata contract containing the task's
acceptance criteria, required checks, unchanged-check requirement,
counterexample obligation, and read-only boundary. The scheduler records every
writer identity across retries and replans, and excludes implementer,
debugger, and integration identities from every dependent verification. A
router that ignores the exclusion set is rejected before the worker starts.

`addDebuggerTask` is the governed repair entry point. It requires structured
failure evidence with the source verification task, attempt, exact command,
exit code, and output-artifact reference. A strict debugger task must emit
`debugger.reproduced` for the same command and exit code and
`debugger.repaired` with before/after artifact references before a successful
settlement is accepted. Verification phase and contract state are carried on
the existing `task.started` and `task.succeeded`/`task.failed` events, while
debugger evidence transitions use dedicated `debugger.*` events. Raw model
reasoning is never part of the debugger input.

Static frozen plans that never call `addDebuggerTask` use a runtime bridge: when
a planned verification fails with a runner-authored `WorkerResult.failedCheck`
and a planned debugging task depends on it, the engine binds the same failure
evidence and strict debugger-contract metadata that `addDebuggerTask` would set.
Settlement without exact reproduction plus before/after repair evidence fails.
The bridge never parses diagnosis or evidence free-form text for command/exit
code — only the structured failed-check carrier. `missionEngine.failureEvidence`
and `missionEngine.debuggerContract` are engine-owned metadata: a static plan
that supplies either key fails closed, and generic task admission rejects them.
Replay trusts these fields only after a dedicated engine evidence-binding event.

The package intentionally keeps these contracts in `TaskSpec.metadata` so the
wire protocol stays additive. The runner continues to enforce the filesystem
read-only boundary and trusted acceptance checks at execution time, and is the
only author of `WorkerResult.failedCheck`.
