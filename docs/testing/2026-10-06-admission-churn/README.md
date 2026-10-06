# VUH-1724 — bounded native admission during process churn

Candidate `odo/vuh-1724-admission-churn`, based on `origin/main` `d3895f61`.
[Issue and prior evidence](https://linear.app/vuhlp/issue/VUH-1724/worker-fleet-tools-time-out-and-unresolved-reports-block-later).
This addresses native admission only; earlier worker tool and receipt fixes stay intact.

## Cause and change

The socket helper discarded its entire census when a same-user process appeared
between `PROC_ALL_PIDS` and the UID/RUID lists, or a live process's listed FD
became unavailable. Repeating the whole scan exposed it to the next unrelated
birth/closure. The recorded production failures exhausted 32 attempts.

The helper now inspects the bounded, sorted union of all three PID lists, so a
new candidate cannot hide a second socket owner. A transient PID/FD race repeats
only that process's complete observation. Each retry discards that candidate;
only agreeing before/after identities contribute ownership. Once a matching
socket has been observed, instability requires a new whole census within the
same budget so a newly born inheritor cannot hide outside the earlier lists.
Confirmed unrelated exits are skipped; unavailable live same-user observations still fail closed. The selected
owner, socket, ancestry, expected lifetime, current Herdr pane and private-seat
registration retain their final checks.

The existing 200 ms scan, 600 ms job, 32-scan and 1 s active transport limits are
unchanged. Local attempts share those same clocks and retain the 32-attempt
ceiling. No request replay, admission cache, caller PID authority or larger
constant was added. Persistent uncertainty can still refuse admission.

## Deterministic real-boundary evidence

The separately compiled `scheduled.c` fixture includes the actual production
helper and wraps libproc call scheduling. It creates/reaps only owned processes
and closes only their own descriptors. Every returned PID, identity, FD, socket
and errno comes from the real macOS kernel. No successful proof or Herdr reply
is synthesized, and the shipped helper has no fixture controls.

The integration runs real loopback HTTP through `LocalFleetLink` and
`localFleetProof`, an isolated Herdr daemon, a client actually launched beneath
its pane shell, and the body-owned persistent helper transport. It forces:

- A live birth after the all-process list, visible in the later user lists.
- FD closure between `LISTFDS` and the socket query (real Darwin `EBADF`).
- Exit between a successful BSD identity read and the FD-list query (real
  `ESRCH`, errno 3, zero bytes at both socket-proof checkpoints).

The baseline comparison compiles the exact unchanged helper from `d3895f61`
under the same scheduling fixture. The two starvation regressions fail the
HTTP-200 assertion with `local_process_membership_required`, zero forwarding
and native `attempts_exhausted` at attempt 32. The confirmed-exit case separately
checks existing safe exit handling; it is not claimed as a new baseline defect.

Measured HTTP admission, including both native checkpoints and real Herdr control:

| Scheduled boundary       | Baseline                        | Candidate                   | Candidate elapsed |
| ------------------------ | ------------------------------- | --------------------------- | ----------------- |
| Birth between PID lists  | HTTP 403, attempt 32, 0 effects | HTTP 200, first global scan | 230.3 ms          |
| FD closure between reads | HTTP 403, attempt 32, 0 effects | HTTP 200, first global scan | 301.9 ms          |
| Confirmed exit / ESRCH   | Existing skip behavior          | HTTP 200, first global scan | 174.4 ms          |

Every legitimate request and same-connection repeat is required to finish in
less than 2 s; each native job retains its 600 ms cap. Outsiders, a forged other
pane and a shared client FD all return HTTP 403 without advancing the forwarding
count. A second owner born **between PID lists** is explicitly refused with
`multiple_owners`, proving that newly merged candidates are actually inspected.
Releasing the shared FD admits a separate later request. Existing native tests
also check owner/socket pins and changed ancestry after parent exit.

## Checks and retained evidence

All heavy commands used `clankie heavy`; dependencies were installed in the fresh
owned worktree. No full gate, eval, simulator, deploy, runtime refresh or grant
change was performed.

- Native helper compiled with `-Wall -Wextra -Werror`.
- Six-file focused run: 44 passed, including the original two scheduled cases,
  real native churn, metrics/refusal boundaries, local proof and native transport.
- Final scheduled fixture run: all three cases passed after adding actual ESRCH
  coverage and correcting the fixture's HTTP server cleanup type.
- Affected app typecheck passed. Scoped lint/format passed; all 459 Markdown
  files passed the local-link check. `git diff --check` passed.

Local evidence under `.local/admission-churn/` in this worktree:
`before.log`, `census/before.json`, `fd/before.json`, `focused.log`,
`scheduled.log`, `{census,fd,exit}/after.json`, `typecheck.log` and `checks.log`.
The public table omits process IDs, ports and private paths. Before/after raw
observations stay local; this report preserves the decisive statuses and bounds.

Reproduce the scoped native regression manually:

```sh
clankie heavy -- node scripts/build-fleet-proof.mjs
clankie heavy -- env FLEET_PROOF_NATIVE_TEST=1 pnpm exec vitest run \
  --config vitest.config.ts \
  apps/clankie/test/native-admission-scheduled-churn.integration.test.ts
```

For the red comparison, save the baseline helper to an absolute local path and
set `FLEET_PROOF_BASELINE_SOURCE` to that path in the same test invocation. The
HTTP-200 assertions must fail for the census and FD cases. The optional baseline
source affects only the separately compiled test fixture.

## Remaining integration evidence

Pell owns the full gate and landing. Actual concurrently active worker calls on
the updated runtime remain untested here; this worktree's successful native
Linear reads are baseline-runtime observations. The supplied historical
`integrate-update-ref/.local/bridge-refusal-diagnostic/REPORT.md` was absent, so
the production timing and seven exhaustion events come from the issue comments.
No production attribution beyond those comments is claimed. No decision is open.

## Integration review boundary

The additional scheduled native fixture covers a target-socket sharer exiting
after all PID lists and handing its descriptor to a live new child. The helper
requires a fresh bounded census rather than forgetting the partial socket
owner. The fixture records the successor's actual kernel lifetime and socket
ownership before cleaning up only its owned children. This direct helper check
does not claim a demonstrated full HTTP dual-checkpoint exploit or live fleet
acceptance. Pell records its baseline and corrected run in the integration
evidence.

Pell reproduced the direct-helper boundary on the original `537f68a7`
implementation: the successor was kernel-observed live and holding the socket,
but the helper exited 0. The corrected scan restarts its bounded census and
refuses the new co-owner. This is a direct native-proof regression, not a claim
of a reproduced complete authenticated HTTP admission. Logs remain under
`.local/odo-review/` in the integration worktree.
