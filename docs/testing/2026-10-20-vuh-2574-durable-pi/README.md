# VUH-2574: private Pi turn restart proof

Tracks: [VUH-2574](https://linear.app/vuhlp/issue/VUH-2574).
Decision: [ADR 0284](../../adr/0284-a-service-restart-pauses-one-pi-room-turn.md).
Comparison: [Pi Durable, durable-harness and local journal](../../proposals/2026-10-20-durable-pi-turns.md).

The manual runner starts the real `apps/clankie/src/index.ts` service on generated
private loopback ports, with isolated state, settings, file memory, broker test
store and a real `openai/gpt-5.4-mini` API model. It admits through
`POST /v1/captain/channel-turns`, writes a real memory, and invokes a real shell
command that appends one marker and waits. Only the private service and its
verified tool PID are killed. A fresh service resumes the original delivery at
startup, without another input. The proof polls the public GET route, verifies
one memory and append, replays repeated input without new steps, rejects a changed
input with 409, and restarts a third time to verify the saved result.

The lead explicitly approved the public HTTP/receipt boundary because no Discord
destination is authorized. **The Discord-mouth hop is unproven.** No Discord
connection, native seat, live service restart or eval is used. Exactly-once remote
effects still require destination idempotency or read-back reconciliation.

## Reproduce

Use a new output directory and an existing API model credential. The runner
copies only that API credential into its private store and deletes it in teardown;
it refuses OAuth credentials so it cannot rotate the live account's refresh token.

```bash
clankie heavy --server -- node --import ./scripts/dependency-types.mjs \
  apps/clankie/scripts/prove-durable-pi-room.ts .local/durable-proof openai/gpt-5.4-mini
```

An optional fourth argument `SIGTERM` exercises orderly shutdown. The default
`SIGKILL` is the abrupt-restart acceptance proof. Source digests must remain
unchanged across every restart. Logs and journals remain under the private output
directory; the runner always stops its service and verifies the command before
killing its recorded tool PID.

## Attempt history

- `proof-1`: stopped before service startup because its synthetic owner ID failed
  numeric Discord-ID validation. The runner now uses numeric fixture IDs.
- `proof-2`: passed real restart, memory, effect, original reply and deduplication.
  This was the initial development proof, before the final replay hardening.
- `proof-final-kill`: behavioral checks passed, but source-stability verification
  correctly rejected an edit made during the run. Not final evidence.
- `proof-3`: one memory and append, completed recovery; its assertion rejected a
  separate observational `cat` command as a second shell call. The assertion now
  counts the original effect command and independently checks its actual output,
  allowing the model to choose how to inspect it without allowing duplicate effects.

- `proof-4` / `proof-term`: both passed unchanged-source behavior checks before
  the first landing gate. That gate caught two journal type errors (`pending`
  cannot be emitted as completed, and tool executors require `details`). A follow-up
  also corrected the effective result-hook snapshot so content replacement drops
  stale structured output and live hooks are not merged twice. The corrected
  module passed a focused typecheck; both real-service proofs were rerun below.

Final source-pinned results and the evidence bundle are recorded below.

## Final results

| Proof                   | Service PIDs          | Interrupted tool PID | Memory notes | Shell appends | Saved HTTP replies | Outcome |
| ----------------------- | --------------------- | -------------------- | ------------ | ------------- | ------------------ | ------- |
| SIGKILL, `proof-5`      | 82091 → 82621 → 83179 | 82607                | 1            | 1             | 1                  | passed  |
| SIGTERM, `proof-term-2` | 83641 → 84136 → 84710 | 84122                | 1            | 1             | 1                  | passed  |

Both use unchanged source across all three service lifetimes. The bundle records
the ten per-file SHA-256 digests, original revision, original native session leaf,
retained branch metadata, actual tool outcomes, final results and production
service logs. SIGKILL recovery returns the interrupted shell intent as possibly
run; the subsequent safe `read` confirms the original marker. SIGTERM also
preserves admission and resumes without another input. All proof services are
stopped and injected API credentials removed.

The focused Discord route/room checks passed **21 tests in three files**. Scoped
lint, dead-code analysis and local documentation links also passed. The required
landing-gate receipt is reported on VUH-2574 with the submitted commit.

[Raw proof bundle](clankie://evidence/sha256/5a0cef4d80caf892bf78ab4f409171a89c870fe5171185fd53a87419b0ae4aca)
contains the measured results and logs. Upload receipt:
`10151ba61fce6b975880e48605cdb94994658651307584ca8ab0710eb0dc763a` (applied).
