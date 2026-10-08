# Hosted Pi workers: source and Linux boundary evidence

Assignment: [VUH-1582](https://linear.app/vuhlp/issue/VUH-1582/hire-pi-workers-through-native-delivery).
Decision: [ADR 0250](../../adr/0250-pi-workers-use-the-same-usability-view.md).

## Result

The public Linux runtime installs Pi CLI 0.87.1, matching the native adapter.
The private managed body enables native Pi and supplies its existing managed or
customer model route. Public defaults remain opt-in. Automatic hiring considers
Pi through the same worker usability report and durable owner holds as the other
harnesses; unavailable capability, credentials or requested models fail closed.
An unavailable managed route also refuses preparation instead of falling back to
another account between discovery and hire.

Linux support preserves original process, session, controller and socket-owner
proof. Process lifetime includes the kernel boot ID, process inode and start
ticks, avoiding PID reuse hidden by coarse timestamps. No terminal delivery or
uncertain-dispatch replay was added.

## Linux proof

An owned disposable Node 24.20.0 Bookworm container installed the published
Pi 0.87.1 CLI, Python and lsof. It mounted these sibling worktrees read-only and
ran the production discovery, process helper, prepared host, account producer,
chooser and settings store through `scripts/proof-linux-pi-process.mjs`.
The Herdr census comes from the grounded Unix fixture; it is not a live hosted
Herdr/Pi TUI hire. All child processes and temporary files belong to the proof.

Run through `clankie heavy`, with `docker run --rm --network none --user node`,
matching the image's unprivileged runtime user. Result:

```json
{
  "result": "passed",
  "kernel": "linux",
  "checks": [
    "published-pi-0.87.1-bundle-hashes-linux-elf",
    "native-session-file-header",
    "shared-pi-usability-producer-models-auto-choice",
    "durable-owner-hold-refuses-auto-then-release-restores",
    "flag-off-and-unverified-models-refuse",
    "production-host-capture-golden-herdr",
    "original-pid-uid-executable-cwd-birth",
    "changed-cwd-visible-stable-birth",
    "original-tcp-client-owner",
    "other-process-not-original-owner",
    "exited-process-refused"
  ],
  "modelCalls": 0
}
```

## Checks and remaining acceptance

All checks ran through `clankie heavy`:

- `pnpm check:landing --maxWorkers=2`: passed formatting, lint, deadcode, cheap
  docs, workspace typechecks and related tests (643 files, 6,109 passed;
  18 files and 48 tests skipped under their existing prerequisites).
- Explicit Pi account, hosted preparation, prepared hire, native capability,
  prepared-host Herdr golden and worker-account integration tests: 6 files,
  50 passed, none skipped. The native account case used installed Pi 0.87.1.
- Private managed-body typecheck, build and 4 focused test files: 19 passed.
- The Linux proof above passed against the final source as the `node` user.

The private body tests exercise its real HTTP settings API,
credential broker and model-provider boundary, including credential disappearance
and recovery. No model turn, evaluation, AWS deployment or service restart was
performed.

Rollout needs matching public runtime and private body images, followed by a live
tenant native hire, delivery, answer/harvest and model billing check. Existing
project-resource trust remains enforced. The older Mac native acceptance items
in [the original evidence](../2026-10-04-pi-workers/README.md) are still open;
these source and kernel checks do not replace them.
