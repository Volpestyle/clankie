# Native claimant liveness and ancestry exit (VUH-1945)

The native helper distinguishes confirmed claimant exit (`caller_exited`) from
an exited intermediate with the same live claimant (`ancestor_exited`). Private
request diagnostics record the failed chain position and failure-time claimant
status. PID/birth stay private; metrics and alerts use fixed reasons.

[Native capture and source archive](clankie://evidence/sha256/4fbb520a27eb9dc0b3bc3d32652f1504629b850c32a088b20d49dc8ab5328f70)
records implementation `8f91a34512ff578c35d7191749f6a8e021dd6ed3`, based on
`29e57808265ca7c1e9f4f460b569c12fd688b86a`.

## Native evidence and retry decision

The pre-re-walk capture refused real parent and grandparent exits at chain
positions 1 and 2 while the same claimant lifetime remained live. Claimant exit
at position 0 refused without replay. The earlier VUH-1941 trace alone did not
establish any of those lifetimes and was not used to reconstruct historical blame.

The scheduled fixture returns only real libproc/sysctl/socket observations.
Darwin returned empty `KERN_PROC_PID` results for these vanished ancestors;
the helper maps that absence to ESRCH and independently confirms the exit.
Raw errno from a successful sysctl is not an error receipt. These current native
observations justify one complete re-walk, without changing the 200 ms scan,
600 ms total or 32-attempt bounds.

The re-walk revalidates the original claimant PID/birth/user and socket with
bracketed reads, discards the failed chain and proves its current ancestry anew.
Parent and grandparent exit recover native facts for the same claimant/socket;
the vanished ancestor is absent from those facts. A second intermediate exit
refuses with `ancestor_exited`, retry false. Confirmed caller exit never replays.
Unavailable and changed identities remain fail-closed.

## Acceptance

The three manual acceptance checks passed through real native contracts:

- Live claimant; stale PID, birth and socket pins refused; confirmed claimant
  exit at chain position 0 refused with `caller_exited` and no replay.
- Real parent/grandparent exits at positions 1 and 2 recover fresh ancestry
  once. A second intermediate exit refuses; native retry counters stay separate
  from terminal proof counts.
- Isolated real Herdr and HTTP: member 200, wrong pane 403; a pane member's
  parent exits during its HTTP ancestry walk, native proof re-walks, then the
  same live claimant/socket gets 403 `not_member`. A separate outsider gets 403.
  Five requests produced exactly two effects; all three refusals produced zero.

```sh
clankie heavy -- env FLEET_PROOF_NATIVE_TEST=1 pnpm exec vitest run --config vitest.config.ts \
  apps/clankie/test/native-ancestry-exit.integration.test.ts
```

Final acceptance: 3/3 passed in 3.19 s (test bodies 2.01 s). The archived JSON
contains redacted native captures, fixed metric counters and exact tested source
snapshots/digests. Private PID/birth/socket captures stay under `.local/vuh-1945`.
No deployment, service restart, simulator or eval was performed.

## Retained failed fixture iteration

The stronger HTTP fixture first emitted its kernel capture to raw stderr. The
persistent transport correctly returned `protocol_invalid` and refused before
any new effect. The capture now uses the existing framed diagnostic buffer;
production framing validation was not changed. The failed public counter capture
is retained beside the passing capture. Earlier setup-only failures were a
missing helper argument and trying to launch a second client before the first
owned foreground client exited; those fixture errors were corrected before
acceptance.

## Landing

The final root `clankie heavy -- pnpm check:landing` result and checked HEAD/base
are recorded in the issue's landing report. Owner deploys and closes.
