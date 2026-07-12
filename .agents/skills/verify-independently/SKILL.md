---
description: Use when independently verifying a worker change, mission result, pull request, or repaired failure against frozen acceptance criteria.
---

# Verify independently

Start read-only. Do not trust the implementer’s summary as evidence.

1. Read the task contract and unchanged acceptance criteria.
2. Inspect the actual diff and identify likely failure modes.
3. Reproduce the relevant checks in a clean state.
4. Test boundary conditions, negative paths, concurrency, security, and rollback where relevant.
5. Distinguish pre-existing failures from regressions using the base revision.
6. Record exact commands, exit codes, and artifacts.
7. Return `succeeded`, `failed`, or `blocked`; never silently repair while acting as verifier.
8. On failure, give a minimal causal diagnosis and reproducer for a separate debugger task.

Verification is independent only when its worker identity differs from the writer and it has not inherited unsupported private reasoning from the writer.
