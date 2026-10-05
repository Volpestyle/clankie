# Native local fleet proof

The body admits a local request only when its actual loopback socket belongs to
the current Clankie-linked Herdr pane, or its existing service-owned private-seat
registration. Request headers supply the candidate pane, never a trusted PID.
This helper replaces the `lsof` socket and global `ps` ancestry scans; the
accepted boundary remains [ADR 0217](../../docs/adr/0217-fleet-membership-gets-connected-tools.md).

The macOS C helper uses the public SDK's `libproc` process and socket structures.
It scans observable processes for the exact reversed TCP endpoint, requires one
distinct owner PID, and records its microsecond birth, socket identity and
bounded, cycle-free parent chain. Duplicate descriptors in one process remain
valid; descriptors held by two processes refuse admission. Lifetimes are checked
around observations. Protected processes outside the effective user are skipped
only when the kernel establishes that identity; unavailable same-user process
observations fail closed. Process, descriptor, ancestry and elapsed-time bounds
also refuse access rather than returning a partial proof.

The body takes two fresh snapshots around live Herdr and private-seat checks and
requires agreement. Its per-connection identity pin adds a refusal fence against
PID or socket replacement. It never caches authority, skips the census, or
accepts a caller-supplied PID. A missing helper or unsupported platform refuses
admission; there is no legacy socket-scan fallback. Existing project identity
checks still inspect the foreground harness separately, including executable
observations; this change does not relax those checks.

## Build

```sh
pnpm fleet-proof:build
```

Source `dev` and `start` run this preparation before the body starts. The helper
is built under ignored `.local/fleet-proof/`, outside the request path. An
unchanged source, architecture, flags and binary digest reuse that build.
macOS releases ship the signed binary at `libexec/local-fleet-proof`, so installed
users need no compiler. The helper is currently macOS only, matching the existing
local admission support.

## Verification

```sh
FLEET_PROOF_NATIVE_TEST=1 pnpm exec vitest run --config vitest.config.ts \
  apps/clankie/test/local-fleet-proof.integration.test.ts
```

This opt-in integration test uses actual HTTP sockets, the compiled helper and
an isolated real Herdr daemon with owned shell panes. It exercises membership,
foreign panes and processes, revocation, socket exit, changed birth pins and
shared descriptors; the fixture records cold and repeated proof durations in
`.local/proof-cost/`. Legacy socket-scan commands are denied by the test while
real Herdr commands run. No provider credentials or live fleet are needed.

The stale-birth case uses a birth read from a different real process with the
same expected PID as the live client. It proves refusal of a stale lifetime pin
without claiming that macOS was forced to recycle a PID. Kernel PID recycling
cannot be forced within a bounded isolated test on this host.
