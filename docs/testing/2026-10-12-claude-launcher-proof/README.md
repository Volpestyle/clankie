# Claude project proof — VUH-2160

The refusal was a launcher discovery failure, not a transient socket/process
lookup failure. In the running service's private log, 526 recent project
`observation_failed` refusals joined by request ID to `launcher_unavailable`
at checkpoint `launcher`. The service's actual PATH began with two copies of
Clankie's generated Claude shell shim. `installedLauncher` selected that shim
and rejected its `#!/bin/sh` header before observing Claude's processes.
`projectRefusalReason` then reported `observation_failed`. Fleet-only checks
still succeeded, giving the mixed fleet/project traffic an apparent 10% rate.
Codex has no corresponding Claude shim. Recovered native scan diagnostics were
not evidence that those requests failed.

Project proof now reuses the shim's real-Claude discovery on absolute entries
of the service's PATH. It still resolves the actual executable and checks fresh
kernel births, executable/argv, foreground identity, session, binding, socket
ownership and ancestry. No prior success or retry diagnostic grants admission.

## Measurements

The unchanged service's snapshot at 06:40:06Z on October 12 recorded a last-hour
rate of 1,533/15,087 refusals (10.16%), including 1,518 `observation_failed`.
The five-minute per-pane sample included 73/243 (30.04%) for the operator Claude
and 5/39 (12.82%) for two other Claude panes and 4/35 (11.43%) for the fourth. Actual pane and process
identities remain in ignored `.local/vuh-2160/`.

[Paired live evidence](paired-proof.json), 06:45:07–06:45:38Z:

| Actual running panes              | Original project observer              | Fixed project observer |
| --------------------------------- | -------------------------------------- | ---------------------- |
| Four Claude panes, 20 checks each | 80/80 refused (`launcher_unavailable`) | 0/80 refused           |
| One Codex pane, 20 checks         | 0/20 refused                           | 0/20 refused           |

The original observer came from `5a189a93674a38aa7de87b6395934a8b9221fa51`.
Both versions used the existing native Herdr session, actual installed binaries,
the unchanged service PATH extracted from its process, and the checkout's native
kernel helper. No launcher, process observation or Herdr response was replaced.
The four Claude panes included the foreground `clankie claude` wrapper and
hand-started Claude. No existing pane was steered or restarted.

A real localhost TCP caller in the worker's own pane claimed another open Claude
pane. All five fixed `localProjectProof` checks refused it as `not_member`, after
successful project observation. The sockets and helper owned by the proof were
closed. No unit tests were added.

## Remaining live acceptance

The lead owns deployment. These paired observations do not claim that the
unchanged installed service's alert became quiet. After deployment and seat
readoption, retain one full hour of live fleet metrics with several Claude panes
open, measure the refusal deltas and check the alert trail. Attach that evidence
to VUH-2160 before closure.
