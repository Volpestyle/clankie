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

The socket owner requires full `PROC_PIDTBSDINFO` observation and the body's
user identity. Other ancestors use `sysctl(KERN_PROC_PID)` for exact PID, parent
PID, seconds and microseconds of birth across users. This preserves lifetime
checks through Terminal's setuid-root `/usr/bin/login` ancestor without granting
that ancestor ownership or using a weaker owner observation. Unknown, malformed,
changed or exited ancestors still refuse admission.

There are at most three complete attempts, each with a 200 ms monotonic budget
and a 600 ms total cap, inside the body's 1 s helper timeout. An expired attempt
can only start a fresh complete census; incomplete observations never grant
membership.

The body takes two fresh snapshots around live Herdr and private-seat checks and
requires agreement. Its per-connection identity pin adds a refusal fence against
PID or socket replacement. It never caches authority, skips the census, or
accepts a caller-supplied PID. A missing helper or unsupported platform refuses
admission; there is no legacy socket-scan fallback. Project identity separately
checks the shell and foreground harness through the process mode below.

## Shell and foreground process observations

```sh
native-process-proof --processes SHELL_PID AGENT_PID [--diagnostics]
```

Success returns one JSON object, with the two processes in the supplied order:

```json
{
  "schemaVersion": 1,
  "processes": [
    {
      "pid": 123,
      "ppid": 122,
      "uid": 501,
      "birth": ["1791220000", "123456"],
      "executable": "/absolute/path/to/executable",
      "argv": ["argv[0]", "argv[1]"]
    }
  ]
}
```

The example abbreviates the array; successful output always contains exactly two
records. Both require full `PROC_PIDTBSDINFO` observations with effective UID
equal to the body's `getuid()`, a live 64-bit process, and an absolute
`proc_pidpath` executable. Birth seconds and microseconds remain decimal strings.
Each executable and argument must be valid UTF-8; JSON escapes controls, quotes
and backslashes. Each retained argument is bounded to 4096 bytes. The `argv`
array contains exactly the first `min(argc, 2)` arguments, including empty
strings; fewer arguments yield a shorter array, and zero arguments yield `[]`.
Later arguments and environment values never enter output or diagnostics.

`KERN_PROCARGS2` supplies the argument bytes. The helper reads the bounded kernel
argument area, verifies size observations and erases its temporary buffer. It
uses the LP64 executable-path alignment established by XNU's
[`exec_extract_strings`](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_exec.c)
and [`sysctl_procargsx`](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_sysctl.c)
to locate arguments; skipping all NUL padding would incorrectly consume an empty
`argv[0]`. Unsupported widths, truncation, malformed data, inaccessible or exited
targets, and exceeded bounds refuse the entire observation with zero stdout.

The helper captures both processes twice, brackets each executable/argument read
with full process identities, compares executable and argument observations, and
rechecks both identities before emitting. It shares the bounded attempt/time
limits with socket mode, without scanning unrelated processes. The body repeats
the batch around current Herdr and binding checks; executable observations do
not grant membership by themselves. There is no `ps` or `lsof` process fallback.

Kernel argument observations read the process's user stack. They do not provide
immutable exec-time attestation or an atomic snapshot of both processes.
Repeated reads refuse observed changes, but cannot establish that no change
occurred and reverted between observations.

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
at the real `LocalFleetLink` HTTP boundary, with no forwarded effect. The test
then confirms the original PID has exited and admits a new process with a new
birth and socket. This tests the reuse guard without forcing numeric PID recycling.

## Refusal diagnostics and retry

Server-owned opt-in diagnostics report fixed proof stages and native reason
codes, errno, attempt and retry status. The helper's `--diagnostics` writes these
to stderr; its successful stdout schema and generic failure stderr remain the
default contract. No PID, endpoint, command, path, environment or credentials
enter diagnostic events. Diagnostic callbacks cannot change admission.

A process can replace a listed socket FD with a non-socket before the kernel
socket query. macOS returns `ENOTSOCK`; like `EBADF`, this requires a complete
fresh census, rather than skipping the descriptor or treating it as permanent
owner rejection. Sustained churn can exhaust the bounded attempts and refuse
access. The integration exercises actual unrelated descriptor churn, refusal
without forwarding, and recovery with the same socket after churn stops.

An exact `local_process_membership_required` HTTP403 occurs before dispatch for
that request and can safely be followed by a fresh request. The existing worker
bridge does not automatically replay403. Read-only polling may retry; uncertain
writes or lost replies must reconcile their original receipt. A later403 does
not establish that an earlier uncertain operation never ran.
