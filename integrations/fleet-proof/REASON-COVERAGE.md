# Proof reason coverage

`fleet-health-metrics-native.integration.test.ts` runs the real macOS helper,
live loopback TCP sockets, an isolated Herdr daemon and a service-owned private
registry. It asserts all thirteen terminal refusal counters independently of
native retry diagnostics: seventeen attempts, fifteen refusals and two admissions.
It also checks a real provider method refusal and an actual reply corrupted by
an owned Unix relay. No kernel observations or successful provider responses
are fabricated.

| Terminal reason              | Exercised boundary                                                                                                |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `unsupported_platform`       | Host platform configuration refuses a live socket.                                                                |
| `invalid_pane`               | An invalid caller pane claim on a live socket.                                                                    |
| `closed_socket`              | The owned TCP peer is closed; project coverage also closes it after a real native observation.                    |
| `missing_binding`            | The service supplies no current Herdr binding.                                                                    |
| `native_initial_unavailable` | The compiled helper is unavailable at the initial checkpoint.                                                     |
| `native_final_unavailable`   | The real initial observation succeeds, then the final helper is unavailable.                                      |
| `pane_unavailable`           | Real Herdr returns `pane_not_found` on the initial pane read.                                                     |
| `not_member`                 | Neither the actual ancestry nor the service registry grants membership.                                           |
| `snapshot_changed`           | The TCP owner's actual parent exits between observations.                                                         |
| `pane_changed`               | The owned pane is removed between the initial and final Herdr reads.                                              |
| `private_seat_expired`       | The service revokes its actual private registry entry between checks.                                             |
| `binding_changed`            | The service changes its Herdr binding between checks.                                                             |
| `observation_failed`         | The real Herdr control socket is unavailable, rejects an unknown method, or returns a reply corrupted in transit. |

Only Herdr's fixed `pane_not_found` code is preserved by the native control
transport. Other provider errors, invalid JSON, incorrect reply IDs and transport
failures remain generic failures. An initial missing pane maps to
`pane_unavailable`; a missing final pane maps to `pane_changed`. Both refuse
admission. A project socket that closes during asynchronous observation maps to
`closed_socket`, separately from changes in binding or native observations.

## Native diagnostic evidence

The manual native churn test asserts real `multiple_owners`, `owner_mismatch`,
`socket_mismatch`, `invalid_arguments` and `owner_not_found` counters. It uses a
second real PID sharing the connected FD, an invalid server-owned lifetime/socket
pin, and a previously owned TCP pair after both endpoints close.

The project HTTP integration uses real `execv` with a 4097-byte `argv[0]`. The
kernel permits the exec, but the helper's bounded argument observation emits
`argv_invalid`; the project request refuses with HTTP 403 and no forwarded
effect. Project process diagnostics are passed through the same schema and
collector as socket diagnostics; diagnostic hooks do not affect admission.

The redacted fixture
[`exhausted-diagnostics.json`](../../apps/clankie/test/fixtures/local-fleet-proof/exhausted-diagnostics.json)
retains actual `budget_exhausted` and `attempts_exhausted` events from independent
FD-churn runs on unchanged commit `8fcf47a54b578629386bdbc306db3ae2205d57f4`.
Both original requests returned HTTP 403 with zero forwarded effects. Their
source run names, checkpoint, attempt and fixed event fields are retained;
variable PIDs, ports, paths and other request data are omitted. Those same runs
also observed `socket_unavailable`, `process_unavailable` and
`process_census_changed`. The captures prove these OS branches occurred; a
golden replay does not claim to force their occurrence on every machine.

`fleet-health-metrics.integration.test.ts` derives the complete 27-reason native
vocabulary from the helper's diagnostic declarations, compares it to the protocol
enum, and checks every token through the collector and authenticated HTTP schema.
It also counts the captured exhaustion events and rejects an unknown diagnostic
reason. These vocabulary samples are contract inputs, not claims that the OS
produced every possible failure. Native diagnostics never add terminal proof
attempts or inflate the refusal denominator.

The additional manual `fleet-additional-os-native.integration.test.ts` uses the
unchanged production helper and real owned kernel transitions to produce
`executable_unavailable`, `fd_list_bounds`, `executable_changed`, `argv_changed`,
`process_changed`, `ancestry_unavailable`, and `ancestry_changed`. Six checks
cover those seven reasons; direct helper refusals enter the production schema
and collector. [Actual redacted events and scope](../../docs/testing/2026-10-06-additional-defensive-os/README.md)
distinguish these observations from full HTTP admission proofs. The earlier
[four defensive producers](https://github.com/Volpestyle/clankie/blob/e8a7b71e/docs/testing/2026-10-06-proof-alert-defensive-os/README.md)
cover `ancestry_bounds`, `process_census_unavailable`, `fd_list_unavailable`, and
`argv_unavailable` separately.

## Explicit OS coverage limits

The following defensive or race-dependent branches are not forced by these
fixtures. Their tokens are covered by the vocabulary contract above.

| Condition                           | Unexercised reasons                            |
| ----------------------------------- | ---------------------------------------------- |
| Timing or allocation failure        | `clock_unavailable`, `allocation_failed`       |
| Malformed FD or socket observations | `fd_record_invalid`, `socket_identity_invalid` |
| Cyclic ancestry                     | `ancestry_cycle`                               |

A healthy kernel does not return negative FD records or a cyclic process parent
tree. Those checks remain useful fail-closed guards against incompatible or
inconsistent observations; removing them because a fixture cannot produce them
would weaken validation. Clock and allocation failures would require disrupting
the OS or injecting failures. The manual race workloads above bound repeated
fresh observations; their success on this host does not promise an event at a
specific attempt elsewhere.
`clock_unavailable` also covers a failure in the bounded monotonic retry wait.
Pure final-check budget expiration reports `budget_exhausted` without inventing
a socket mismatch.

## Worker receipt failures

`fleet-report-reasons.integration.test.ts` exercises the production installed
sender against real loopback HTTP, the durable conversation store and inbound
receipt fence, and real local files. Every fixed failure reason reaches the
collector, authenticated HTTP schema and CLI five/sixty-minute windows:

| Reason                      | Actual failure boundary                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `binding_timeout`           | The owned binding endpoint holds its response past the request deadline.                                             |
| `binding_unavailable`       | The binding endpoint returns HTTP 503.                                                                               |
| `binding_rejected`          | The binding endpoint denies the request with HTTP 403.                                                               |
| `receipt_timeout`           | The original POST response exceeds its deadline; the local claim remains.                                            |
| `receipt_invalid`           | The service stores the original, then its reply fingerprint is corrupted. Exact GET reconciliation later settles it. |
| `receipt_unresolved`        | The POST returns HTTP 503; the real listener is then closed before refreshed-bridge GET reconciliation.              |
| `connection_refused`        | The real listener closes after binding and before POST dispatch.                                                     |
| `local_receipt_unavailable` | A real file occupies the required claim-directory path.                                                              |

The stored control verifies durable receipt evidence and removes only its exact
claim. Retained originals are reconciled by GET without another POST. Repeated
polls of the same health observation do not add attempts. Snapshots contain only
fixed counters, never report bodies, binding fingerprints, paths or process data.
This proves receipt transport and counter boundaries, not native OS diagnostics.

The proof-alert integration in `fleet-lead-round.integration.test.ts` uses real
TCP refusals and durable native outbox receipts with a captured census boundary.
It proves threshold → `notifyFleetHealthAlert` → exact head acknowledgment, and
that unavailable delivery does not consume the accepted-alert cooldown. Native
owner TUI acceptance remains a separate live proof; this fixture does not claim
that an original operator TUI received the alert.

## Focused checks

```sh
pnpm fleet-proof:build
FLEET_PROOF_NATIVE_TEST=1 PROJECT_NATIVE_PROOF_TEST=1 pnpm exec vitest run --config vitest.config.ts \
  apps/clankie/test/fleet-health-metrics-native.integration.test.ts \
  apps/clankie/test/native-proof-churn.integration.test.ts \
  apps/clankie/test/project-native-proof.integration.test.ts \
  apps/clankie/test/fleet-health-metrics.integration.test.ts
```

Native cases are manual opt-ins. They add no build, subprocess churn or Herdr
daemon to per-push CI. The vocabulary/HTTP contract uses no native build and
remains a fast portable integration check.

Run the additional manual cases under the fleet's heavy wrapper with
`FLEET_ADDITIONAL_OS_TEST=1`; build the production helper first. The owning
fixtures' [lifetime and reproduction notes](../../apps/clankie/test/helpers/native-proof-churn/README.md)
describe their bounded processes and cleanup.
