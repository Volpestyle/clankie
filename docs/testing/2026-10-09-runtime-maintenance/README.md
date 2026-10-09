# VUH-1984: repeated retention blocked deploy admission

The passed-canary polling path invoked its maintenance callback after every poll.
Retention released its filesystem lock correctly, then repeatedly reacquired it,
blocking deploy admission despite an empty deploy-hold registry. A read-only live
capture showed the lock clear between scans and repeated completed inspections.

Successful passed maintenance now runs once per operation per service boot.
Concurrent recovery shares the same callback; failed callbacks remain retryable.
Hold reconciliation still runs, and a fresh process performs recovery cleanup.

Regression proof uses an isolated real Node child, loopback health HTTP,
private canary journals, deploy holds and the actual runtime maintenance lock.
It verifies subsequent maintenance admission, concurrent recovery, failure retry
and another boot. Before the fix both new scenarios failed with repeated scans.
Focused canary/retention checks and the root landing gate provide landing evidence.
Raw logs, the root receipt and sanitized runtime observations are attached to
VUH-1984 from `artifacts/vuh-1984-maintenance`.

The owner deploys. No override, runtime state edit, runtime restart or PC action
was performed for this fix; live deployment confirmation remains owner proof.
