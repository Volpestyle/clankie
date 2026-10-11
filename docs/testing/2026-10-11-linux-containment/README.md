# Linux namespace containment and durable cleanup receipts

Tracks: https://linear.app/vuhlp/issue/VUH-2091

This is the authorized Mac-local slice: a Linux containment primitive and
per-job cleanup journal. It does not allocate capacity or alter Mac admission.
The future Windows host must register a canonical budget permit and bind the
prepared Linux birth before allowing execution. Windows interop containment,
native/WSL shared-budget dispatch, installation and PC proofs remain open.
Detected WSL is refused. No PC or WSL calls were made for this slice; KH2's
build lock stays in place.

The journal records an OS-account owner and namespace init by native PID,
boot ID/start ticks and UID, plus the namespace inode and PID-1 witness.
Dedicated `flock` guards the receipt; atomic temp/fsync/replace/directory-fsync
preserves it independently of the lock. An exclusive job ID cannot be reused.
The command cannot execute until `prepared` is durable and its private control
pipe authorizes `go`; `running` is durable before the gate opens. No arguments
are persisted. Unknown or corrupt observations retain the receipt.

Cancellation signals the pinned init through its pidfd. Wrapper/setup crash
propagates SIGKILL through parent-death signals whose inherited parent pidfds
close the setup race. Linux namespace-init exit kills and waits for every
remaining member, including detached and nested-namespace descendants. Release
requires kernel exit of that pinned init or a fresh native observation proving
its recorded birth gone; a reply or saved `empty` flag is insufficient.
The kernel guarantee follows Linux 5.15's
[`zap_pid_ns_processes`](https://github.com/torvalds/linux/blob/v5.15/kernel/pid_namespace.c)
and its [exit ordering](https://github.com/torvalds/linux/blob/v5.15/kernel/exit.c).
The actual proof below runs on Linux 6.12.76-linuxkit, not the PC's 5.15 kernel.

Verified locally:

- Three portable journal contracts passed on macOS. They cover uncertain
  recovery, changed native birth, malformed claims, mismatched journal binding,
  atomic replacement, lock exclusion and exclusive job IDs. The normal Vitest
  landing wrapper passed; the explicitly enabled Linux runtime test is skipped
  on an ordinary Mac gate.
- Eight real Linux integration cases passed in 12.201 seconds: durable gate plus
  live lock and invalid-token refusal; cancellation of detached double-forks and
  nested PID namespaces; stdin EOF; wrapper SIGKILL plus crash-lock recovery;
  init SIGKILL; root-command exit retaining cleanup until leftovers die;
  wrapper interruption; and wrapper crash before execution authorization.
  Every cleanup checks recorded descendant births and heartbeats, while an
  unrelated same-user process survives. No process dependency is mocked.
- The first six-case proof passed in 11.472 seconds. The release boundary was
  subsequently tightened to require native exit proof even after a supervisor
  `done` reply; a second six-case proof passed in 11.442 seconds, then the final
  eight-case proof covered interruption and a crash before execution too.
- Package typecheck, scoped lint and formatting passed. Three earlier typecheck
  attempts failed on missing Node types or the protocol package's `zod` link
  while worktree dependency copies were incomplete; those logs are retained.
  Dependencies were copied into this tree, with no links to another checkout.

Proof environment: existing Docker Desktop 29.6.1, local Unix context
`desktop-linux`, image `clankie-runtime:ac45d633e5ed` with digest
`sha256:2440397fa3cd7d7a3820e84ea3dc2c84d63c462f8f50d8f5ef7f7c9393eedf77`.
Only disposable owned containers were created, without network, downloads,
privileged mode or added capabilities. Each had two CPUs, 512 MiB RAM and 128
PIDs; source was mounted read-only. Docker's seccomp namespace-syscall filter
and protected system paths had to be disabled inside those containers. The
initial capability probe, without the path-mask exception, failed mounting
private `/proc` with EPERM. With both scoped exceptions, an unprivileged
65534:65534 process created a user/mount/PID namespace and reported PID 1.
This proves the container boundary only; it does not prove WSL prerequisites or
authorize changing host/WSL configuration.

Reproduce with the existing local image, from the repo root:

```sh
clankie heavy -- docker run --rm --pull never --network none \
  --cpus 2 --memory 512m --pids-limit 128 --user 65534:65534 \
  --security-opt seccomp=unconfined --security-opt systempaths=unconfined \
  --mount "type=bind,src=$PWD/packages/fleet-resources,dst=/proof,readonly" \
  --entrypoint /usr/bin/python3 clankie-runtime:ac45d633e5ed \
  -I -B /proof/test/fixtures/linux-namespace-proof.py --integration
clankie heavy -- pnpm exec vitest run packages/fleet-resources/test/linux-namespace.integration.test.ts
```

All tests, typechecks, dependency preparation and container runs used
`clankie heavy`. The integrator supplies the exact-tree landing gate; no
duplicate local root gate was run. Raw logs and checked sources are archived
in `evidence.json`.

Release packaging follow-up (Basil review `a7755e38`):

The runtime asset allow-list now includes `linux-namespace.py` beside `native.py`.
A search of script/integration allow-lists found no other named copy to update.
The Python proof fixture lives under `test/fixtures`; it is not a release asset.
An owned Docker container with `--init` and `CLANKIE_LINUX_NAMESPACE_PROOF=1`
copied only the two runtime helpers to a release-shaped source directory, then
ran the real eight-case fixture against that directory. All eight passed in
11.975 seconds, including wrapper/init crash, cancellation, detached descendants
and exclusive-lock recovery. The same image and resource limits above were used.
This is a real Python runtime proof, not the ordinary Mac wrapper's skipped test.
The follow-up is based on fetched `d4eac6a65`; the exact-tree gate is pending.
