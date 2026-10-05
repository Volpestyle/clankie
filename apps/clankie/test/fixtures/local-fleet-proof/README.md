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
one pane and an outsider client make real persistent TCP requests. Production
proof, native socket/process observations and Herdr process-info remain real.
A real inherited copy of the HTTP socket is held by a second owned process to
prove duplicate-owner refusal and recovery after that process exits. A command
guard rejects legacy lsof/ps scans while delegating real Herdr execution.
Nothing connects to the user's Herdr socket, Clankie service or credentials.
Cleanup stops only the owned daemon/children and removes their temporary root.
Logs and measured cold/warm proof timings remain under `.local/proof-cost/integration-*`.

The stale-identity case retains the member's actual PID and socket identity but
supplies another real process's birth timestamp through the server-owned
additional refusal pin. It proves lifetime mismatch rejection at the PID reuse
boundary; it does **not** claim the kernel actually recycled a PID. New connection
admission, binding revocation, foreign/removed pane, outsider and closed socket
refusals are also exercised. Twenty warm calls require p95 below 100 ms and max
below 250 ms; daemon startup is excluded and cold proof time is reported separately.

This manual integration is opt-in so regular test/CI runs never launch a daemon.
