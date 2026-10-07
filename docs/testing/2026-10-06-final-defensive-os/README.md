# VUH-1704 final defensive OS boundaries

This follow-up starts from `origin/main` in the isolated
`lux/final-os-producers` worktree. The prior
[eleven-producer handoff](https://github.com/Volpestyle/clankie/blob/c45a61b6e01b1fbba7256b7dd3c42611370079b7/docs/testing/2026-10-06-additional-defensive-os/README.md)
remains separate. This record distinguishes native producer evidence from the
lead's explicitly revised defensive-guard acceptance.

| Remaining reason          | Evidence                                                                                                                                                         | Classification                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| `clock_unavailable`       | Actual per-helper OS denial of libc retry wait, on real TCP/process observations; original monotonic clock still works.                                          | Real OS producer              |
| `fd_record_invalid`       | Pinned kernel/ABI review and direct production guard checks for negative/valid descriptor fields.                                                                | **defensive, not producible** |
| `socket_identity_invalid` | Pinned kernel/ABI review and direct production guard checks for missing/complete Unix/TCP identity fields.                                                       | **defensive, not producible** |
| `allocation_failed`       | Bounded real data/address-space caps and denial probes produced no target event; setup/loader failures and successful proofs are retained separately.            | **Unproved**                  |
| `ancestry_cycle`          | Real child debugger attaches to its own parent; reciprocal kernel PPIDs cause a production-helper refusal, then its stable supervisor reaps the original target. | Real OS producer              |

## Real retry-wait refusal

[The actual capture](clock-probe.json) records a successful normal clock/wait
baseline, a still-successful monotonic clock under the child-only sandbox, and
the real wait denial. Actual bounded process churn caused the helper to retry
its census; the denied retry wait produced `clock_unavailable`, refused that
proof and reached the production schema, aggregate counter and both counter
windows. Successful earlier independent observations remain in the capture.
No libc function, kernel observation or proof response is replaced. The deny
profile changes only its owned helper invocation, never host policy.

## Real cyclic parentage

[The native capture](native.json) confirms actual reciprocal kernel PPIDs, one
`ancestry_cycle` refusal, the real schema/counter/windows and original target
reaping. Normal ad hoc debug signing applies only to the fixture. The unchanged
production helper receives a real connected TCP pair and no substituted process
facts. The tracer is created before its parent opens the client FD, so it holds
no copy of that socket. It addresses only its own still-live parent, detaches,
continues that target and exits. An untraced supervisor survives reparenting and
uses the actual kernel wait receipt after detach; the complete owned workload
exits before its heavy permit ends.

The first unsigned attach returned `EPERM`; that was not cycle evidence. The
first signed exploratory fixture exposed a cleanup bug: a high-level wait
reported exit during reparenting while the original target remained stopped.
The heavy wrapper retained the permit. Only that independently verified owned
stopped lifetime was continued, then the wrapper completed. The checked fixture
adds the stable supervisor and explicit detach/continue/reap sequence. Its run
and wrapper both exit successfully. The earlier exploratory cleanup is not
represented as a successful lifecycle test.

## Direct defensive guards

The lead revised acceptance on 2026-10-06: kernel/ABI review plus direct guard
path tests satisfy the two branches that cannot be produced through supported
OS APIs on the reviewed ABI. See the [pinned Apple source review](kernel-audit.md).

`record-guards.c` includes the actual production guard and diagnostic code with
only its entry point renamed. Eleven explicit inputs cover negative and valid
FD fields, each missing TCP/Unix socket identity field, complete identity
controls and the unused Unix TCP-generation field. These are deliberately
direct validation inputs, not OS records or a fabricated native admission
response. The seven refusal diagnostics pass through the production schema,
collector and five/sixty-minute windows. Terminal proof attempts stay zero.
The shared guards preserve both production call sites' original return/retry
semantics and validation. No malformed input is fed into a live socket proof.
Actual direct check results and fixed diagnostics are also retained in [the native capture](native.json).

## Candidate limits and open acceptance

A rejected `setrlimit`, an early loader failure or a denied debugger attach is
not the helper's target diagnostic. Owned soft-limit probes do not allocate
their numeric limit or exhaust host memory. They retain the original hard
limit. The debugger candidate addresses only a fixture's newly forked parent,
has a bounded lifetime, and changes no proof-helper or existing fleet process.
[Failed candidate summaries](failed-candidates.json) retain the observed exit
counts and absence of native target events. Low pre-exec caps returned `EINVAL`;
accepted caps yielded valid proofs or earlier loader exits. Post-load caps and
fresh stock allocator-zone candidates also yielded successful proofs. VM-trap
and Unix-map denial candidates produced no target event. Some profile variants
were rejected before the production entry ran. Future-only wiring returned
`Function not implemented`. These failures do not prove that allocation failure
is impossible in production; they leave this producer acceptance open.

The post-load candidates were isolated C drivers entering the unmodified
production entry after a real self-policy operation. They are unsuccessful
candidates, not installed-helper producer claims. Allocator functions and kernel
observations were not replaced. No denied or crashed setup is reclassified as a
native counter event. Raw failed candidates stay under ignored `.local/final-os/`.

Original owner-TUI threshold delivery and the next Linear receipt remain the
lead/Ash VUH-1743 acceptance dependency. This change supplies no new original
owner receipt and does not restart or repoint that lane. Direct diagnostics and
protocol-client ACKs do not establish original TUI delivery.

## Focused reproduction

Use a real macOS install, the built production helper and both fleet wrappers:

```sh
~/.herdr-handoffs/clankie-backlog-20261003/bin/heavy clankie heavy --seat Lux -- node scripts/build-fleet-proof.mjs
~/.herdr-handoffs/clankie-backlog-20261003/bin/heavy clankie heavy --seat Lux -- env FLEET_FINAL_OS_TEST=1 pnpm exec vitest run apps/clankie/test/fleet-final-os-native.integration.test.ts
```

[Focused checks](checks.txt) pass: three new manual native/direct checks, the
existing real TCP/shared-FD check, service typecheck, scoped lint, formatting
and 472 documentation link checks. Four additional vocabulary/collector/HTTP
contract cases pass with the factored production guards. The existing file's other two cases were
intentionally not run. Actual OS producers now cover thirteen of the sixteen
formerly unmet reasons; the two explicitly accepted defensive guards cover two
more. `allocation_failed` remains unproved. Keep that producer acceptance open unless
the lead explicitly revises it; this record does not classify it as impossible.

These cases are manual Darwin opt-ins; they add no native build or churn to
push CI. No simulator, eval or service model turn is used. The owned worktree's
frozen dependency install used the actual lockfile and real packages.
