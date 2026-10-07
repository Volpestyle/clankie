# Receipt commands within the Windows bound (VUH-1780)

On runtime `b730c091` every PowerShell host receipt operation refused before
dispatch: `Remote hire receipt command exceeds the Windows command-line bound;
nothing dispatched`. The unknown-abandonment change grew the inline host program
to 20,062 characters. Shipped on every call, it encoded to ~28,300 characters
before any claim. With the real `3989da1d` claim, reserve, launch and seal
measured 30,102 characters and recover 30,274, all over the 30,000 guard. Reserve
precedes every remote hire, so no PC worker could be hired and the original
could not settle.

The cause was the design, not the guard. The program is now installed once per
version at `~/.clankie/hire-receipt-programs/<sha256>.js`. Five bounded install
calls write content-addressed parts atomically. The parts become the program
file only when the inflated bytes match the digest. Each operation sends a small
loader, the digest, a refusal marker unique to that dispatch and the
service-authored request. The loader hashes the bytes it read and evaluates
exactly those bytes. A missing or different file refuses before the program
runs, leaving no host state changed. Only that exact marker lets the service
install the program and send the same request once more. Any other failure,
uncertain outcome or second refusal stops with nothing retried. The journal
locks, exact claim/nonce/history checks, launch-once CAS and target pinning are
unchanged inside the program.

Measured PowerShell command lengths for the real `3989da1d` claim:

| Operation                            | Before |    After |
| ------------------------------------ | -----: | -------: |
| reserve                              | 30,102 |    7,990 |
| launch                               | 30,102 |    7,978 |
| seal                                 | 30,102 |    7,978 |
| recover (`abandoned-unknown`)        | 30,274 |    8,438 |
| install, per call (once per version) |    n/a | ≤ 14,122 |

Program growth now adds install calls; it no longer adds length to a call.

Source verification passed:

- `clankie heavy -- pnpm --filter @clankie/clankie typecheck`, then
  `HIRE_RECEIPT_NATIVE_TEST=1 pnpm exec vitest run` over
  `remote-hire-receipts.integration`, `fresh-hire-intent.integration`,
  `hire-brief-receipt` and `opencode-fleet-lifecycle.integration`: **48 tests /
  4 files passed**.
- The new boundary test fails if any operation or install command for a
  production-sized PC claim exceeds half the 30,000 bound. It then runs the real
  loader and installer through `/bin/sh` on a fresh host: refuse, install,
  dispatch once. It replaces the installed file and checks that the replacement
  is never evaluated and that the original journal stays byte-identical.
- Scoped `oxfmt` and `oxlint --deny-warnings`: **passed**.
- Read-only PC probe through `volpe@supedupsilly` (PowerShell 5.1). The loader
  refused with its exact per-dispatch marker and wrote nothing. A `node -e`
  argv echo returned the digest, marker and quoted request JSON byte-identical.
- A native read-only security review **approved** the change with no blockers.
  Its one hardening note, a per-dispatch rather than fixed refusal marker, is
  applied.

Live steps remain after deploy: settle `3989da1d` as `abandoned-unknown` against
the PC, with the original fenced and its journal retained, then take one fresh
PC hire past reservation. No program was installed on the PC, no receipt was
settled and no hire ran during this work.
