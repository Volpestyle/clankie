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

## Initial deployment handoff

The lead owned deployment. The paired observations did not establish that the
unchanged installed service's alert became quiet. At initial landing, the
full-hour runtime acceptance was still pending; its later results follow.

## Deployed hour

Runtime `5e850e02e`, 2026-10-12T08:32:37.511Z–2026-10-12T09:32:38.462Z
(60 minutes and 0.951 seconds), after the lead's confirmed readoption:

- 16,606 checks; 40 aggregate refusals (0.24%), compared with
  1,533/15,087 (10.16%) in the measured old-runtime hour.
- Zero `observation_failed` counter delta and zero Claude refusals.
  Five Claude panes were present in every recorded rolling five-minute sample.
- All three lookup diagnostics occurred on every observed Claude pane.
  Aggregate diagnostic deltas: 863 `process_unavailable`, 262 `socket_unavailable`,
  and 279 `process_census_changed`. These counts describe diagnostics, not failed calls.
- Other refusals were retained: 33 `native_initial_unavailable`, one
  `native_final_unavailable`, two `pane_unavailable`, and four `not_member`.

The aggregate alert stayed quiet, but two caller-specific Codex alerts reached
the lead at 08:36:40Z and 08:44:16Z. Their windows recorded 7/254 refusals
(six `native_initial_unavailable` plus the pre-baseline startup refusal) and
6/391 (all `native_initial_unavailable`). The hour therefore does not satisfy
the issue's quiet-alert acceptance criterion. VUH-2160 remains Verifying;
[VUH-2170](https://linear.app/vuhlp/issue/VUH-2170/idle-codex-seat-continues-native-initial-unavailable-proof-churn-after)
tracks the continuing Codex churn separately.

Overlapping conversation journal reads cover aggregate service notices only.
Caller-specific alerts can be delivered directly to the lead's native mailbox
without appearing there. The corrected evidence also retains the two delivered
notices from the lead's native transcript. The initial evidence packet's claim
of zero proof alerts was incomplete and is explicitly superseded.

The first deployment's 07:51:04.079–08:30:06.164Z window recorded 9,276 checks
and 14 other refusals, with zero target refusals or proof alerts. The next
lead deployment interrupted it, so it is not an hour pass. The second runtime's
startup included one Codex fleet `observation_failed` at 08:32:04.755Z, before
the saved settled baseline; it remains separately recorded in the evidence.

An additional real TCP caller was reparented to launchd while remaining in its
governed job's process group. Kernel ancestry contained only that caller, with
parent PID 1 and no Herdr ancestor. All five project checks refused it as
`not_member`; the sockets, caller and helper were cleaned up.

[Full captured evidence, attached to VUH-2160](https://linear.app/vuhlp/issue/VUH-2160/claude-panes-fail-fleet-proof-checks-about-10percent-of-the-time-codex).
Attachment: “Corrected VUH-2160 live hour and trust-boundary evidence”. Actual pane details
stay on the private issue and in ignored `.local/vuh-2160/`.

## Absolute PATH follow-up

The reused pane lookup treats an empty PATH as the working directory. Filtering
an all-relative service PATH to empty must therefore refuse before invoking it.
A real open Claude pane and a cwd symlink to its actual installed binary proved
the edge: the initial patch admitted both empty and all-relative PATH cases;
the guard refuses both as `launcher_unavailable`. The actual service PATH still
passes. No launcher, process or Herdr response was substituted.

The hour's service PATH contains absolute entries, so its successful discovery
uses the same lookup before and after this guard. The live hour is retained for
that unchanged input; the guard has its own real boundary proof. No unit tests
were added.
