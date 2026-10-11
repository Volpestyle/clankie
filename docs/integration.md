# Approved commit integration

`clankie integrate` lets the service compose and gate an ordered batch of already
approved commits. The caller owns review and approval. The service must run from
a source checkout with Git and pnpm available; installed release and hosted
clients do not expose this local repository operation.

```bash
clankie integrate CORE_SHA CORE_SHA --app APP_SHA --push --no-wait
clankie integrate CORE_SHA --id UUID --no-wait
clankie integrate status
clankie integrate status UUID
clankie integrate push UUID
clankie integrate cancel UUID --actor NAME --reason TEXT
clankie integrate revert PASSED_BATCH_UUID --push
```

Using it is optional: changes land directly on `main` after their root landing gate passes
([ADR 0240](adr/0240-changes-land-directly-on-main.md)). When you want a composed,
gated batch, push a branch, run `clankie integrate <sha> --push --no-wait`, then
follow with `clankie integrate status`. `status` without a UUID shows
running batches, waiting requests, the last result and interrupted work;
`status UUID` follows one request through shared batches and failure isolation.
The TUI `/integrate` shows the same queue.

Core inputs are positional; repeat `--app SHA` in order for the optional app.
Core may be empty when only app commits are supplied. The service uses its own
checkout and the sibling `clankie-app` checkout. Each batch clones their Git
objects independently, fetches current `origin/main`, and creates detached
`clankie`/`clankie-app` worktrees beside each other so the app resolves core's
protocol. It never switches or installs in either live source checkout.
Every input records its full SHA and applied/already-present/conflict/failed
result. A conflicting request rolls back across both repositories before the next
request is applied. Its later inputs are blocked and its error and conflicting
paths remain in the batch record. Healthy requests continue. Repair by approving
new commits and composing a fresh batch.

The service serializes gates and coalesces compatible waiting requests in batches
of **at most three requests**. Push requests coalesce past gate-only ones;
gate-only requests never land. Restores run alone and remain admission-order
barriers, including retries admitted before the restore.

A failed shared gate queues each surviving member for an individual attempt.
Retries keep their original admission priority, ahead of later requests; fresh
batches cannot coalesce across an older retry. Innocent members re-gate and land
first rather than returning to the back of the queue.
Each member needs at most its shared attempt and one individual attempt to
attribute that failure. Main moving into checked inputs still requires the
existing bounded re-gating described below. Failure of a single request is
terminal; base or infrastructure faults may independently fail every member.
Every attempt retains its logs and exact tree.

An individual attempt can retain a repository's earlier zero-exit gate only when
its exact tree, base, approved contributions, source, destination and sibling
core candidate are unchanged. It retains the actual gated commit and log, with
`gateReuse` recording the original batch, tree and core HEAD. Every repository
is installed again, and any repository without a valid pass gates again. The
app consumes core sources: excluding a failed core contribution invalidates the
earlier app pass even when the app tree itself is unchanged. A withdrawal always
requires fresh gates. Landing checks the durable pass and reused tree/core input;
an unchanged app tree alone never authorizes landing. If origin advances after a
pass is reused, it requires a fresh gate even if normal selection revalidation
could cover the same tree; reuse requires the original base too.

Requests retain their UUID and input. `batchId` follows the current attestation,
`attempts` retains attempt IDs, and `isolation.rootBatchId` identifies the failed
shared gate. While a retry waits it is `queued`, can be withdrawn, and its failed
attempt remains in the chain. `status` exposes `progress.isolationChain` with each
attempt's member count, state and recorded gate exit; `/integrate` displays it.
`progress.queuePosition` counts scheduled batches (zero is running). Status's
waiting list follows that schedule, including coalescing and restore barriers.

`progress.estimatedRemainingMs` and `estimatedCompletionAt` estimate completion
from the median of up to eight measured gate jobs completed by this queue process
and the jobs currently ahead. They are conditional estimates, not deadlines:
new arrivals, machine pressure, remote fallback and main moving can change them.
Without a completed measurement or a known position, the estimate is `null`
(`estimateBasis: unknown`); the TUI shows `ETA unknown`. Restarting resets timing
samples and interrupts owned work rather than inventing a resumable gate.

An owner can withdraw a waiting request or an active isolated retry with
`cancel UUID --actor NAME --reason TEXT`. The durable `cancelled` receipt names
who and why. A running isolated gate finishes without killing its process, but
**a tree containing a withdrawn input cannot land even if its gate passes**.
Surviving requests are composed and gated again on a fresh tree before landing;
other queued members continue. The first, non-isolated gate and a landing already
under way cannot be cancelled. Repeating cancellation returns the original
receipt. Cancelling does not undo code already landed by another request.

Each batch runs real `pnpm install --frozen-lockfile`
with a private store and copied packages, then each included repository's
`pnpm check:landing`, or `pnpm check` where it defines none
([ADR 0247](adr/0247-narrow-checks-have-one-command.md)). `check:landing` runs
lint, typecheck and the tests related to files changed since the batch base,
which the queue passes as `CLANKIE_LANDING_BASE`; the full `pnpm check` stays
for releases and manual runs. Core also runs `pnpm deadcode` before typecheck
and tests: measured knip execution costs about 2–3 seconds and catches unused
exports and missing declarations before landing. Evals remain outside both. Gate processes start with private
HOME, XDG directories, Clankie state and fleet descriptors, and a file credential
broker, before any Vitest setup can snapshot owner paths. On macOS and Linux their
TMPDIR is a short private `/tmp/clankie-gate-*` directory linked from the batch's
isolation root, because Unix socket paths under the deep batch root exceed the
~104-byte limit. Their environment has
no inherited tokens, keys, service URLs, harness configuration, or Node options;
default service addresses point at an unavailable local port. This isolates
normal repository checks from the live install; it is not a sandbox for malicious
approved code or checks that deliberately contact hard-coded external services.
Rust checks use the host's installed compiler binaries directly, with private
Cargo/Rustup homes and no borrowed package caches. Missing native tools fail the
recorded gate; the queue does not install or update the owner's toolchain.

`~/.clankie/integration/batches/<UUID>/record.json` (under `CLANKIE_STATE` when
configured) retains each install/gate exit code, signal, tested HEAD, times and
log path. Atomic replacement and fsync finish before pass/landing admission.
Both HEADs and clean worktrees must still match the durable zero-exit gate.
Destination changes or a missing/failed record refuse landing.
`--push` performs ordinary fast-forward SHA-to-main pushes, always core first,
then app. It does not deploy or restart the live service, so deploy holds do not
apply to it.

When origin/main moved after the gate, landing rebases the batch onto it and runs
`pnpm check:landing --revalidate` in the batch worktree, the same check a direct
landing uses: it compares the incoming commits with the gate's recorded
selection. When the gate still covers the rebased HEAD, the batch lands without
a new gate. Each repository's `revalidations` record the incoming commits it
checked, the rebased HEAD and the verdict, and `/integrate` names them. When the
gate no longer covers HEAD, the rebase conflicts or the repository has no
`check:landing`, the batch is held with the reason and the queue composes and
gates its requests again on the new main, at most twice; the fresh batch's
`regateReason` says why. A restore, or core moving under a batch that includes
the app (whose gate ran against the earlier core), always gates again. A
deliberate `push UUID` of a held batch revalidates the same way; when that is
not enough it stays held, and the requests need a new submission.

Two repositories cannot land atomically. If core succeeds and app is rejected,
the batch says `partial`, records core's confirmed landed SHA, and explains
“Core landed …; app pending.” A deliberate `push UUID` after repairing a definite
app rejection skips core and sends only app, provided origins and tested trees
still match. An uncertain send is reconciled by reading origin, never replayed.
If origin moved and revalidation does not cover it, compose a new batch using
the recorded inputs; commits already present are recorded as such. Push
attempts retain separate logs.

`revert` restores the tree from an explicitly selected passed batch in a **new
commit on current origin/main**, installs, gates and lands that commit through
the same checks. Select the last known good batch; the tool does not decide
whether a production failure invalidates a previously passed tree. History
remains intact; no force push is used.

## Gates on a linked machine

With `clankie fleet set --remote-gates on` (off by default), a core-only batch
may install and gate on a linked machine instead of this one (VUH-2066). The
queue places it there only when this machine is saturated (every heavy slot
held, a heavy job queued, or pressure unhealthy) and the linked machine has at
least `workers` access and answers that it is provisioned, runs no other gate,
and is under the same load and memory guards plus 8 GiB. Otherwise, or when
staging fails, the gate runs here and the batch's `placement` records why.

Remote placement and staging share a two-minute deadline. If discovery, SSH or
staging stalls, the batch records the phase and machine (when selected) in its
local placement reason and runs the normal gate here. Cleanup has a separate
ten-second limit, so an unavailable remote workspace cannot hold the serial
queue. Cancellation stops only the SSH child created by that request, with a
one-second grace before SIGKILL; it does not stop another batch or steer remote
owner processes. Each remote install and gate has a ninety-minute wall-clock
limit and a ten-minute limit without stdout or stderr. Output resets only the
silence limit. Fetching the gate report has a separate two-minute limit. A
timeout retains the machine, phase and cause in the remote log and placement
reason, then freshly installs and gates the exact composed tree locally.
Remote success is never inferred from a disconnected transport. The progress
observer alerts after three minutes without remote output, before fallback.

These conservative initial limits allow reported 20–40-minute full PC gates
and several minutes of quiet cold Rust builds. Retained partial gate failures
took 154 and 180 seconds; no successful full-run measurement was retained here.
Revisit the bounds with a successful full-run measurement.

The linked machine runs the gate in WSL under `~/.clankie-fleet`: its own Node,
pnpm, Rust and ffmpeg, one clone of the public origin, and one directory per
batch with a private home, temp and package store. The queue sends the composed
HEAD as a length-prefixed git bundle over the fleet's existing SSH connection
(the end of input does not always cross SSH, PowerShell and WSL), verifies the
remote HEAD before install, streams the install and gate output into
`core-install-<machine>.log` and `core-gate-<machine>.log`, and copies the gate's
`.local/landing-gate.json` back, so revalidation and push stay here. No
credentials go to that machine. `workers` access suffices because hired workers
there already run repository code in their own workspaces; the gate never runs
in the owner's panes, Herdr session, shell profile or checkouts.

That machine's green stands only when its gate skipped no test in a file that
names darwin: the suite has macOS-only cases a Linux run skips. Any other
outcome (a failed install or gate, or a darwin-only skip) installs and gates
the batch again here, keeping that machine's logs beside the local ones.

## Native delivery contract checks

For changes to native seat delivery, mailbox receipts or their bridge, run the
explicit consumer gate alongside the covering checks:

```sh
clankie heavy -- pnpm test:seat-delivery
```

It runs the whole captain native-chat, SeatOutbox, inbound-recovery, Claude
reconciliation and linked worker-bridge files with no bail. This includes
existing consumers of changed return shapes and bridge files launched as
subprocesses, which a static related-test graph can miss. Select tests from
both the changed producer and its callers; a few new transport tests do not
prove old consumers still satisfy the contract. Keep the results and inspected
failures in the issue evidence. This is a focused manual gate, not a full suite
or an added per-push CI run; evals stay separate.

## Deploy holds

```bash
clankie integrate hold --holder 'Bram w3Z:p2N' --pane w3Z:p2N --reason 'live test' --minutes 30
clankie integrate holds
clankie integrate release HOLD_UUID --actor 'Clankie (lead)' --reason 'test finished'
clankie update --override-hold HOLD_UUID --actor James --reason 'test may end'
```

A deploy hold keeps runtime updates (`clankie update`, scheduled updates and the
machine session's update tool) from replacing the running service while someone
relies on it, such as a live test. It does not hold `main`: direct pushes and
`integrate --push` go ahead
([ADR 0240](adr/0240-changes-land-directly-on-main.md), amended 2026-10-10).

A hold records its holder, reason, creation time, `expiresAt` and optional
`--pane` or `--seat`. `--minutes` is required, from 1 to 60. At expiry the hold
lifts on its own: admission ignores it from that moment, and the service writes
an `expire` receipt naming the holder within about 15 seconds, even if nothing
reads the registry. To keep holding, place a new hold, which is a new visible
decision with its own receipt. Holds placed before this rule lift 60 minutes
after their creation. The runtime canary's own holds are the exception: they
end with their canary, and a failed canary's hold stays until the owner releases
or overrides it (see [`update`](cli.md)).

Use fleet-qualified IDs for remote holders. Status reports `present`, `gone`,
`unknown` (unavailable census) or `person`. A gone holder still holds until
expiry. `clankie fleet status`, the lead's periodic round and every `update`
refusal show each hold's holder, how long it has held and the time left.
Runtime-update admission and the registry share one lock, so a hold cannot race
an admission. Existing admitted deployments are not cancelled by a later hold.

The holder releases its own hold when done; the lead or owner releases anyone's
hold that has outlived its purpose. Every release, override and expiry is a
durable receipt with the hold (holder included), actor, reason and time;
`integrate holds` returns the latest ones and `release` returns its own. Only
the authenticated operator can override a hold for an update, explicitly naming
**every** hold with `--override-hold` plus `--actor` and `--reason`, or all of
them with `update --override-holds --reason TEXT`. The actor is an audit label,
not authentication. Overrides leave holds in place.

CLI stdout is one JSON result; stderr prints the batch ID before submission.
By default it waits for a terminal result; `--no-wait` returns after admission.
A caller-supplied `--id UUID` makes a lost response reconcilable: repeated identical
requests read the existing batch, and different input under that ID is refused.
No network mutation is automatically retried.

After a service crash, an active record reports `interrupted`, not a pass.
`queue.lock`, `push.lock` and `landing.lock` directories name their PID and
time. A lock whose owner took it before the current process started and whose
PID is dead is reclaimed: it moves aside in one rename and its owner is checked
again, so only one process takes it over. When the queue reclaims `queue.lock`,
the batches the dead owner left running are recorded `interrupted` with that
reason; resubmit them. A lock with a live owner still refuses. Inspect the
record, logs, processes and origin before starting a fresh batch. Batch
worktrees, stores and evidence are retained for review; cleanup is manual after
their processes have ended. Never move a tree while its gate is running.

The operator API is `POST /v1/integrate` with typed `run`, `status`, `push`,
`cancel`, `hold`, `holds` and `release` actions in
[`packages/protocol/src/integrate.ts`](../packages/protocol/src/integrate.ts).
`run` takes a caller-created UUID, core/app arrays, optional `restore` batch UUID
and `push`. It returns immediately; poll `status`. A push request reads `pushing`
from its pass until it lands, so polling ends at `pushed`, `held` or `partial`; one
that rests at `passed` never started landing, and `push UUID` lands it.
`hold` requires `minutes`.
The [API client](../packages/api-client/src/index.ts) exposes `integrate`.
The [local-bare-repo integration tests](../apps/clankie/test/integrate.integration.test.ts)
exercise the gate and landing boundary without a live origin or live full check.
