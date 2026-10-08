# Canary hold lifecycle — VUH-1863

Read VUH-1863, VUH-1845 and `4619a30a` before changing the lifecycle.
The live status read confirmed a completed, passed `883d3dfb` update on
`65e45e09`, with `holdReleased: true`, still labelled pending, and the older
failed `9aded960` canary hold on `a1eef8f4`. No live hold, journal, deployment,
service or worker lane was changed.

## Trace and change

The hold registry audits overrides without removing holds. The updater retires
safe terminal locks on admission; status previously labelled every active lock
pending even after completion. The canary previously released only its current
operation's hold and skipped cleanup when that hold was already released.
Together these leave the older hold blocking subsequent normal updates and
make status misleading. The previous nonaccepted override response did not
retain a refusal reason: its precise scheduling blocker cannot be proved from
that response. In particular, the completed lock alone is not evidence that
admission refused it; admission already knows how to retire a safe terminal lock.

The accepted operation now retains exact overridden hold snapshots before
helper scheduling. A full passing canary releases verified canary holds from
those snapshots or its recorded installed-runtime predecessors, checking the
hold's identity, owner, reason, timestamp and lack of pane/seat ownership under
the registry lock. Recovery repeats cleanup when its own hold was already
released. Independent, unreadable, unrelated and changed-owner holds survive.
Failed observations remain failed; releases append audit events.

Status reports pending only for unfinished or unresolved operations and makes
no state writes. Admission retires terminal locks. A nonaccepted request names
`blockedReason`: `update-in-progress` or `runtime-maintenance-busy`. Overrides
cannot bypass those lifecycle boundaries.

## Boundary evidence

- [Release/helper integration](../../../apps/tui/test/release-update.integration.test.ts):
  actual HTTP 503 samples fail a canary; normal deployment is held; an
  authenticated CLI override schedules the detached release helper and retains
  its admitted hold snapshots; real archive/checksum/filesystem cutover reaches
  healthy; real passing HTTP samples release the old and current holds; a newer
  published target then schedules without an override. This reuses the existing
  isolated release launcher fixture for supervisor responses, not a production
  service deployment. Historical failure and both override/release audits are checked.
- [Canary integration](../../../apps/clankie/test/runtime-canary.integration.test.ts):
  actual candidate child processes and loopback health prove already-released
  canary recovery through override and predecessor evidence, changed-owner and
  unreadable hold preservation, and continued holds when the replacement fails.
- [Source updater integration](../../../apps/tui/test/runtime-update.integration.test.ts):
  real Git plus the native detached helper prove finished status is read-only,
  maintenance refusal is explicit, and the next update schedules. The minimal
  Git target then safely refuses unsupported cutover; this check does not claim
  a source service deployment.
- [CLI/API refusal integration](../../../apps/clankie/test/runtime-update-ux.integration.test.ts):
  an owner override against an unfinished operation reports
  `blockedReason: update-in-progress` and schedules nothing.

## Operator recovery on the Mac

The old runtime still needs an explicit audited release before it can install
this change. Clankie should re-read status and confirm the same reviewed failed
hold and the passing `883d3dfb` canary, then run:

```sh
clankie integrate release 9aded960-af0b-43a3-befb-89ca00467458 --actor Clankie --reason "VUH-1863: failed a1eef8f4 observation superseded by the full passing 65e45e09 canary (883d3dfb); release the stale hold to install the lifecycle fix"
clankie update --ref main --json
```

Verify `accepted: true`, finish the initiating turn, and read update status on
the next turn through canary completion. A confirmed `accepted: false` schedules
nothing: inspect maintenance/lifecycle evidence before retrying. A disconnected
or lost response remains uncertain; reconcile by reading status instead of
resending. Do not edit update journals or remove locks. Landing alone does not
change the running service or release this existing hold.

## Landing gate repair

The gate exposed an existing routing-test metadata enumeration bug:
`worker-parent-routing.test.ts` treated `owner-updates.json` as a conversation
directory and tried reading `owner-updates.json/meta.json` (`ENOTDIR`). The same
case failed in a clean archive of fetched `origin/main`
`0f825f03e107a083228d209770f96d28ff032066` with its own frozen dependency install.
The helper now enumerates directories only; delivery assertions and production
routing are unchanged. The original and baseline failure logs are retained in
`.local/vuh-1863/` in the task checkout. No check was waived.

## Conversation reader audit

No corresponding product bug was found. `ConversationStore` boot and inbound
acceptance scans use `withFileTypes` and skip nondirectories. Listing, replay,
tails and retention operate on that loaded metadata; retained byte accounting
visits only known conversation IDs. `issue-metrics.ts` also skips nondirectories
before reading metadata, so neither `owner-updates.json` nor
`linear-event-receipts.json` becomes a metrics source or unreadable-source warning.
`ConversationJournal` reads a selected ID rather than enumerating the root;
the trace CLI and shipped trace queries use those ID-based readers. Pane tidy
and worktree tidy read their own journals and registered worktrees, not the
conversation root. The repository's remaining product directory scans do not
enumerate that root. Only the routing-test helper required correction; its
existing failing delivery sequence exercises the real owner-updates sidecar.

## Verification

`clankie heavy -- pnpm check:landing` passed: formatting, lint (including Vox),
deadcode, docs links and retired claims, all 31 workspace typechecks, and
1,527 affected tests across 190 files (five tests and two files skipped by their
existing conditions). The original focused canary/release run passed all 44
tests. The landing run includes the corrected source-status/API assertions
and routing helper. No evals or live deployments ran.
