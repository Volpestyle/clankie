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

The package intentionally keeps these contracts in `TaskSpec.metadata` so the
wire protocol remains additive-free while the protocol is frozen. The runner
continues to enforce the filesystem read-only boundary and trusted acceptance
checks at execution time.
