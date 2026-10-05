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
