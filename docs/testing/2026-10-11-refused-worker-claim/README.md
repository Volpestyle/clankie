# Refused worker POST claim: VUH-2125

Tracks: [VUH-2125](https://linear.app/vuhlp/issue/VUH-2125/stabilize-refused-worker-message-claim-proof-on-the-macos-release).

The release run [38131786566](https://github.com/Volpestyle/clankie/actions/runs/38131786566) failed the fleet refusal case with `uncertain` instead of `unavailable`, then its isolated rerun passed. The retained Juno log supplies the failure excerpt in this archive.

The fixture released its binding response before stopping its listener, assuming the bridge's next POST would see `ECONNREFUSED`. A transport reset during shutdown is ambiguous and must stay uncertain. The test now stops the listener and polls a real fresh TCP connection for `ECONNREFUSED` before releasing the binding response. This removes the scheduling assumption; it does not change delivery classification or replay behavior. The historical run did not retain the underlying socket error, so its exact transport error remains inferred from the race and observed receipt, not directly measured.

All assertions remain: unavailable original, no accepted POST, a later new delivery ID and exactly one new-message POST. Production code is unchanged. The bridge's existing 5,000 ms call deadline and all product/test timeouts remain unchanged; the fixture condition poll is bounded at the same 5,000 ms.

Verification uses the existing manual native CPU-bandwidth reproduction harness from the release-concurrency evidence, adapted only for the current required private status-path argument. It runs under `clankie heavy` with three cores and one Vitest worker, touching only proven births in its own group. Five repetitions passed both refusal cases (10/10), alongside the full worker-link file (49/49). Final typed-tree worker-link run passed 49/49 and TUI source plus all four test-shard typechecks passed (76.60 seconds).

This is shared-Mac CPU-bandwidth simulation, not physical GitHub three-core hardware or an exact macOS runner reproduction. Native observation races caused transient CPU-enforcement degradation warnings; these are retained, so a continuously enforced three-core ceiling is not claimed. An initial harness invocation failed before tests because its retained script lacked the new argument. Initial typecheck found a nullable captured address; saving the validated listener port corrected it. Both failed attempts remain in the archive. No production deadline, assertion or governor was weakened.

Base: fresh fetched `origin/main` `c123cf488`. Formatter ran directly. Integration exact-tree gate and pushed revision are recorded on the issue after submission.
