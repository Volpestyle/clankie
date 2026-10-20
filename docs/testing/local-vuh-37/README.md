# LOCAL-VUH-37 — message-specific Codex watch admission

Tracks: LOCAL-VUH-37 in Clankie Work (`/Users/james/dev/tracker-research-20261008`).

Implementation and protocol-fixture validation are complete. **Live acceptance remains pending deployment and a fresh A/B proof; LOCAL-VUH-26 stays PARTIAL.** No service restart or deployment was performed by this worker.

## Cause and behavior

A service restart loses the Codex adapter's in-memory controls. Follow-up delivery then used `codex queue`, reduced its receipt to a boolean, and returned no messageId. Automatic completion watches excluded queued sends. Explicit `herdr_watch` admission checked pane status before arming and accepted no requested messageId. Consequently a fast turn could finish before any scoped watch existed; pane `done` could describe a different turn.

Local queued sends now use the existing native queue RPC on the observed server and return `codex-input:<clientUserMessageId>`. A queue receipt is input acceptance, not evidence of model awareness or completion. The exact native `userMessage.clientId` joins this input to the later native turn. Steering returns its selected native turn ID. Uncertain sends retain the attempted native identity and never authorize queue replay.

Confirmed Codex follow-ups with IDs automatically arm a message-specific watcher. The lead can also call `herdr_watch({agent, reason, messageId})` after a fast turn finishes: this bypasses pane-level done, waits for that identity, and reports the actual native turn in its wake. A read-only native completion observer recovers local turns after loss of the original controller. It reads retained native turns on the observed endpoint and rechecks the exact occupant, native process, socket and worker access around reads; it never resumes, sends, interrupts or answers questions. Abort closes the observer. Missing native correlation remains explicitly unconfirmed.

Harvest claims now retain the native completion with the requested ID. Re-arming an already harvested identity returns `settled_for_message` and that completion, without a second wake. Legacy claims without completion return `already_harvested`; they never borrow a pane's latest done. Wake text includes watch ID, requested native input ID and the actual turn ID where distinct, making later native proof inspectable.

## Checks

- Five focused files: **146 tests passed**. Coverage includes queue identity receipts, completion before the send receipt returns, explicit late arming, simultaneous A-completed/B-pending exclusion (equal input text), retained completion lookup without another wake, and cancellation without another send. These use a local protocol server fixture, **not a real Codex model**.
- Source plus the two affected test roots: **471 TypeScript roots passed** through the standard bounded supervisor; reported compiler heap 2035.9 MiB. Local scoped config is retained with the logs.
- Explicit changed-file formatting and lint passed. `git diff --check` and `node scripts/check-swallowed-rejections.mjs <base>` passed. The integrator owns the exact-tree landing gate; local focused checks do not substitute for it.

The packet retains the final successful checks, earlier failed iterations, scoped config and source diff for candid provenance. Earlier failures were corrected: unsafe endpoint fallback is now refused, the queue-failure fixture supplies observed daemon argv, and TypeScript/format/lint diagnostics are fixed. No CI workflow was added or expanded, and no eval ran.

## Limits

- A deployed A/B proof, exactly-once native wake correlation and an overlapping unrelated-turn negative control are still required before closing LOCAL-VUH-26.
- This new read-only reconnection observer covers local Codex. Remote queues that still provide legacy boolean-only receipts remain uncorrelated; Prime and native revocation acceptance were not exercised.
- The existing harness-native and connection-fence paths remain in place. An unobserved/unsupported endpoint refuses queue dispatch rather than choosing a shared daemon. No terminal input fallback is added.
- Integration and deployment status are reported separately on the work item and to the lead; this README does not claim a landed or running candidate.

Raw validation/diff bytes are in the evidence-store tar linked by `evidence.json`. Only this README and the manifest belong in Git.
