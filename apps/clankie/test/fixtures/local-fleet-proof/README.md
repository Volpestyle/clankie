# Native local fleet proof integration

Run explicitly on macOS after building the production helper through the checkout
build script. The test uses production `fleetProcessHelper(checkout)` resolution
(`libexec/local-fleet-proof` in a release, otherwise
`.local/fleet-proof/native-process-proof`):

```sh
pnpm fleet-proof:build
FLEET_PROOF_NATIVE_TEST=1 pnpm exec vitest run apps/clankie/test/local-fleet-proof.integration.test.ts
```

The fixture launches an owned isolated Herdr daemon with separate config, state,
runtime and sockets, and `/bin/sh` panes. An ordinary Node client launched inside
one pane and an outsider client make real persistent TCP requests. The real Hono
listener and `LocalFleetLink` seat route guard an in-memory effect counter. Production proof, native socket/process observations and Herdr
process-info remain real. Request path and pane header always match, including
wrong-pane claims, so those refusals exercise native membership.
A real inherited copy of the HTTP socket is held by a second owned process to
prove duplicate-owner refusal and recovery after that process exits. A command
guard rejects legacy lsof/ps scans while delegating real Herdr execution.
Nothing connects to the user's Herdr socket, Clankie service or credentials.
Cleanup stops only the owned daemon/children and removes their temporary root.
Logs, cold/warm proof timings and lifetime evidence remain under
`.local/proof-cost/lifetime-*`.

The stale-identity case retains the member's actual PID and socket identity but
supplies another real process's birth timestamp through the server-owned
additional refusal pin. It proves lifetime mismatch rejection at the PID reuse
boundary; it does **not** claim the kernel actually recycled a PID. New connection
admission, binding revocation, foreign/removed pane, outsider and closed socket
refusals are also exercised. The lifetime case confirms the original member is
still alive on the same native socket before HTTP403, with no forwarding effect;
then it waits for kernel `kill(pid, 0)` to return ESRCH before starting a replacement.
The replacement must have a new PID, native birth and socket identity and produce
one admitted effect. This proves actual exit and replacement without claiming
literal PID reuse. Twenty warm calls require p95 below 100 ms and max
below 250 ms; daemon startup is excluded and cold proof time is reported separately.

This manual integration is opt-in so regular test/CI runs never launch a daemon.

For the login-ancestor regression, run the same test in an owned PTY through the
current user's native `/usr/bin/login -flpq <current-user>` with
`FLEET_PROOF_LOGIN_TEST=1`. The test requires a real login ancestor with effective
UID 0 different from the caller, then checks that its PID and kernel birth remain
in the admitted snapshot. Metadata observation uses macOS `ps` ruid/uid (uid is
effective UID), outside the proof hot path, and never reads argv/environment.

An unrelated owned `fd-churn.c` process repeatedly replaces real socket descriptors
with `/dev/null`; it stops on stdin and has its own five-second ceiling. One
request during churn must receive HTTP403 without forwarding, with native
socket-unavailable diagnostics. After stopping the churn, a distinct fresh
request on the unchanged member PID/birth/socket must be admitted. That controlled
recovery does not retry or hide the refused request.

`FLEET_PROOF_CPU_LOAD=1` adds exactly two ordinary owned processes that burn CPU
for five seconds, retaining their PIDs, elapsed time and CPU usage. This is a
manual load check, never an all-core stress test. Warm samples are still twenty
distinct requests and every one must pass; their assertions run after lifetime
evidence collection so unexpected refusals stay visible without discarding the
independent lifecycle checks. Optional sanitized proof diagnostics are collected
without replacing the production observer.
