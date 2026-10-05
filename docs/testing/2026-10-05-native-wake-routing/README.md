# Native-owned self-wake routing regression

Date: 2026-10-05. Base: `ae91cca8186f5b4d83197a930f213039d59f94c2`.

A stored self-wake for the default conversation was due at 17:00Z. The native
operator seat remained recorded as current, but its polling mailbox was idle.
The internal runner fell through to Pi and stalled in compaction. The wake stayed
due and retried five seconds after each failed run. Worker-report delivery errors
were separate queued runs, delayed behind these compactions.

The read-only operator snapshot captured at 2026-10-05T20:51:08.654065+00:00 joins the
turn metrics to conversation journal run IDs:

| Observation                                       | Result                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| Model-labelled failed runs since 19:01Z           | 15                                                                    |
| Failure reasons                                   | 13 compaction/summarization stalls, 2 interrupted by service restarts |
| Retained context at the start of every run        | 316,397 tokens                                                        |
| Tool calls / runs with reported usage             | 0 / 0                                                                 |
| Sum of recorded turn durations                    | 101.43 minutes                                                        |
| Run IDs shared with retained-worker-report errors | 0                                                                     |

Recorded context and wall time do not establish billed token consumption.
The provider's reason for the compaction stalls remains unproven. This fix avoids
starting the irrelevant Pi session; it does not discard its existing context.

## Changed behavior

Internal deliveries to a native-owned conversation refuse service fallback even
while its receiver is offline. Human input retains its existing explicit service
fallback. Goals retain their existing pause behavior. Failed self-wakes stay
scheduled with per-conversation exponential retry delay, starting at five seconds
and capped at five minutes. A replacement wake resets that delay.

## Reproduction and checks

`apps/clankie/test/native-wake-report.integration.test.ts` exercises real durable
wake state, conversation admission and journals, inbound report receipts,
SeatOutbox delivery/acknowledgment and protocol schemas. Time is controlled;
service-session callbacks are forbidden. It makes no provider, live harness,
SSH or account calls and uses only temporary state.

- On the base source, the offline receiver regression fails: 720 wake attempts
  in one simulated hour (expected fewer than 20). The same input on the fixed
  source makes fewer than 20 attempts, with zero service-session starts and zero
  model-turn metric rows; the original wake survives restart.
- Reconnecting the native receiver delivers the original wake and report once;
  repeated report recovery and inbound acceptance preserve the delivery ID.
  Explicit inbox acknowledgment remains separate from transport delivery.
- Another conversation's wake delivers while the first waits in backoff.
- Focused regression, driver, inbound recovery, parent routing and autonomy
  suites: 80 tests pass. Scoped Clankie typecheck, lint and formatting pass.

Detailed red/green output and the redacted live metric snapshot are retained in
`.local/evidence/native-report-wakes/` in the feature worktree. Full `pnpm check`,
evals, deployments and live settings/state changes were not performed.

## Operator stopgap and remaining check

Until the fixed runtime is deployed, the lead can use `/autonomy off` to retain
the pending wake while disabling the service's autonomous scheduling. This is a
service-wide switch. Cancel only the active service run for the default
conversation through the existing conversation cancel API; keep the native
operator seat running. After deployment, `/autonomy on` restores scheduling.
An alternative `/autonomy clear` removes the selected chat's scheduled wake;
it does not cancel an already running turn.

Post-deployment, the lead should verify that this native-owned chat stops adding
service model metrics and that worker receipts are delivered/read through the
native seat. No production verification is claimed here.
