# Self-build target fixture

The lead-agent lab copies this fixture into an isolated temporary workspace. The implementation worker must add `src/retry.mjs`. The verifier runs `test/retry.test.mjs`. The first implementation is deliberately faulty so the orchestration layer must detect, diagnose, repair, and re-verify it.
