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
