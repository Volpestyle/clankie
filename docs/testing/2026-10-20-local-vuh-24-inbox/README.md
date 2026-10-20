# LOCAL-VUH-24 — Work inbox snooze

Tracks: LOCAL-VUH-24 (`clankie-work://local/issue/22293a04-de53-48d8-b5a0-fe92c3466ff2`).

The candidate implements API/CLI attention-only snoozing of the existing
tracker-linked pending decision, gate and verification questions. The minimal
contract and file map are in [Work inbox attention](../../work-inbox.md).
Raw evidence and the product patch are linked by [evidence.json](evidence.json).
The upload record's commit identifies the base of this uncommitted candidate;
the final checked and integrated commits are recorded in the issue's bundle.

## Observed results

- Actual source service, captain, tracker, file credential broker, ordinary
  signed-device pairing/revocation, HTTP and source CLI; no mocked dependency,
  provider/model, eval, owner answer or live-tracker snooze.
- A new sterile broker preset: empty projects/devices, Auto off, no selected or
  effective model and no providers. Only private noninstalled ports/storage.
- CLI inbox list → snooze → omitted from normal read → visible in snoozed read.
  Underlying `get_issue` remained byte-equivalent as a parsed response.
- Another genuinely paired actor still saw active attention, could not change
  the first actor's snooze, and lost access after actual device revocation.
  Wrong store/project, forged actor and Markdown backend calls refused.
- The actual private service stopped and reopened the same durable stores.
  Snooze persisted; unsnooze restored attention; real elapsed time restored
  attention. A cancelled synthetic question stayed absent after expiry.
- Focused tests: **4 files / 41 tests passed**. These additionally exercise real
  storage/current mailbox records, keyed replay, timestamp/revision bounds,
  filtering before pagination, actual store replacement, changed binding,
  final publication after tracker/question changes, actor isolation including
  expired records, and unchanged gate/run/delivery/verification state.
  These focused tests use controlled host authority seams; they do not substitute
  for the separate real public-service proof above.
- Touched-file lint and formatting passed. The root landing gate log/JSON and
  integration result are separate bundle references; this README is not a gate.

## Reproduce the public proof

```bash
node scripts/scratch-stack.mjs .local/inbox-proof --broker-operator
git init --quiet .local/inbox-proof
clankie heavy --server -- node scripts/manual/work-inbox-proof.mjs .local/inbox-proof run
```

The runner starts only that preset's service, drives its source CLI/public API,
stops and reopens it, then stops it in `finally`. It retains no owner answers
or device credentials in its output. Remove the entire private preset after
confirming the owned listener and process are stopped.

Two preliminary proof-harness attempts used the wrong existing inventory
authentication route and failed as expected (401); they were corrected before
this complete run. Their private roots were stopped and removed. The runtime
also reported harmless checkout-sync refusals because the disposable Git repo
has no remote; these were not treated as an inbox pass or hidden.

## Limits and remaining review

Current authenticated-owner/current-link semantics apply. Publication rechecks
are not an atomic transaction across the asynchronous tracker rename and mailbox
resolution; a post-dispatch failure reports may-have-committed uncertainty.
Store identity is current linkage, not birth-store provenance. Native MCP without
a genuine owner-mailbox capability refuses explicitly. No new cached authority,
save/retention hook, notification store or configuration system was introduced.

The independent bundle check and owner Done decision remain open. Work UI
discovery/presentation, iPhone/iPad/Mac visual acceptance, the VUH-1921 parent
milestone/dependencies and James's review are not waived. The installed runtime
was neither restarted nor deployed.
