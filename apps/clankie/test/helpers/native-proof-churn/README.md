# Native proof churn fixtures

Run explicitly on macOS after `pnpm fleet-proof:build`:

```sh
FLEET_PROOF_NATIVE_TEST=1 pnpm exec vitest run --config vitest.config.ts apps/clankie/test/native-proof-churn.integration.test.ts
```

The test uses the production persistent C helper and real loopback sockets. It
compiles only this small owned process fixture and the existing real FD-churn
fixture under ignored `.local/project-proof/churn/native/integration/`. No
syscall, socket observation or admission dependency is replaced.

`processes.c churn` repeatedly forks/exits children, with a 5 s maximum lifetime
and stdin stop. `share` holds the actual connected TCP FD supplied as stdio FD 3,
with stdin stop and a 10 s maximum. `descendant PORT` forks a real unique TCP owner;
its parent holds no client socket. Exiting the parent reparents that owner, so
a fresh proof must no longer offer the former parent's lifetime. The owner has
a 10 s maximum and is cleaned up only after a current native birth check.

All separate read-only observations, including refusals followed by later
independent observations, are retained in `requests.json`. The availability
case permits up to 3 refusals in 30 requests under two bounded unrelated process
loops; complete successful facts must stay identical. The shared-FD case must
refuse even during unrelated FD churn, then recover the exact original socket
after the additional owner exits. Ancestor facts alone do not grant pane
membership; the body's unchanged ancestry/registry fences consume them.

Do not run this churn experiment concurrently with a performance benchmark.

The additional `FLEET_ADDITIONAL_OS_TEST=1` manual file uses `fd-bounds.c` to
open 16,384 extra real FDs under only its own soft limit (maximum 1.5 s), and
`exec-changes.c` for real distinct executable transitions or changes to the
running program's own argument storage (maximum 3 s). `reparent.c` exits its
owned parent after stdin closes; its live leaf lasts at most 20 ms. The driver
waits for inherited pipes to close before beginning another iteration.
`ancestry-race.c` gives only the leaf a TCP FD and exits the root to change the
middle ancestor. Both descendants last at most 100 ms; root stdin wait is at
most one second. Kernel calls, helper budgets and diagnostic schemas are
unchanged. The driver observes at most 512 reparent or 256 ancestry workloads
and stops when the target event is observed.

Build and run through the fleet heavy wrapper:

```sh
clankie heavy -- pnpm fleet-proof:build
clankie heavy -- env FLEET_ADDITIONAL_OS_TEST=1 pnpm exec vitest run apps/clankie/test/fleet-additional-os-native.integration.test.ts
```

The backlog fleet also requires its outer `bin/heavy` wrapper. These direct
native diagnostics do not independently prove full HTTP/Herdr admission.

## Denied native retry wait

`clock-wait.c` calls the actual monotonic clock and `nanosleep`, and reports the
Darwin SDK's cancellable and noncancellable semaphore-wait syscall IDs. The
manual `fleet-final-os-native.integration.test.ts` checks its baseline, then
denies only those IDs for an owned helper invocation. Bounded real process
churn makes a fresh helper observation retry; the OS refuses that retry wait
and the unchanged helper emits `clock_unavailable`. The clock itself remains
available. No libc function, kernel observation or helper allocation is replaced.

```sh
clankie heavy -- node scripts/build-fleet-proof.mjs
clankie heavy -- env FLEET_FINAL_OS_TEST=1 pnpm exec vitest run apps/clankie/test/fleet-final-os-native.integration.test.ts
```

The case is a manual Darwin opt-in and adds no churn/build to push CI. Raw owned
observations and real production counter snapshots stay under ignored
`.local/final-os/clock-*/evidence.json`; the public redacted capture is in
`docs/testing/2026-10-06-final-defensive-os/`. Direct diagnostics do not establish
full HTTP admission or original owner-TUI alert acceptance.

`record-guards.c` directly includes the production C validation and diagnostic
implementations with only the entry point renamed. Its explicit records check
negative descriptors and missing Unix/TCP identity fields, plus valid field
controls. They are direct guard inputs, not OS observations. The manual test
passes the actual guard diagnostics through the production schema and collector.
The lead accepts these two reviewed branches as **defensive, not producible**;
no synthetic record is passed into a live admission proof.

`ancestry-cycle.c` creates an untraced supervisor, a TCP-owning child, and that
child's own debugger before the socket is opened. Only the debugger fixture is
ad hoc signed for normal debugging. Its actual attach creates reciprocal kernel
PPIDs; the production helper sees and refuses the cycle. Detach plus `SIGCONT`
resumes that same still-live target. The untraced supervisor survives reparenting
and reaps its original child after the detach receipt. A high-level wait during
reparenting can return `ECHILD` without exit, so it is not used as that receipt.
No existing process or proof-helper code is addressed by the debugger.
