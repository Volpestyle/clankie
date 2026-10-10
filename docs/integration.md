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

The service serializes batches, coalescing requests waiting during a gate into
the next batch in admission order. Requests must have the same push intent;
restores run alone. The existing per-request input
limits do not cap the combined batch. Requests retain their original UUID and input; a
`batchId` points to the shared attestation and `attempts` retains previous batch
IDs. A failed shared gate splits into smaller fresh batches until each failing
request is reported; good subsets gate and land independently on fresh origin.
A failed single request is terminal and cannot block later arrivals. Shared gate
failures caused by the base or infrastructure may affect every member; diagnosis
is bounded by smaller subsets, and every failure retains its logs.

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
Origin drift, destination changes or a missing/failed record refuse landing.
`--push` performs ordinary fast-forward SHA-to-main pushes, always core first,
then app. It does not deploy or restart the live service, so deploy holds do not
apply to it.

Two repositories cannot land atomically. If core succeeds and app is rejected,
the batch says `partial`, records core's confirmed landed SHA, and explains
“Core landed …; app pending.” A deliberate `push UUID` after repairing a definite
app rejection skips core and sends only app, provided origins and tested trees
still match. An uncertain send is reconciled by reading origin, never replayed.
If origin moved, compose a new batch using the recorded inputs; commits already
present are recorded as such. Push attempts retain separate logs.

`revert` restores the tree from an explicitly selected passed batch in a **new
commit on current origin/main**, installs, gates and lands that commit through
the same checks. Select the last known good batch; the tool does not decide
whether a production failure invalidates a previously passed tree. History
remains intact; no force push is used.

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
Retained `queue.lock`, `push.lock` or `landing.lock` directories name their PID
and time; a PID alone cannot prove safe recovery. Inspect the record, logs,
processes and origin before removing a lock or starting a fresh batch. Batch
worktrees, stores and evidence are retained for review; cleanup is manual after
their processes have ended. Never move a tree while its gate is running.

The operator API is `POST /v1/integrate` with typed `run`, `status`, `push`,
`hold`, `holds` and `release` actions in
[`packages/protocol/src/integrate.ts`](../packages/protocol/src/integrate.ts).
`run` takes a caller-created UUID, core/app arrays, optional `restore` batch UUID
and `push`. It returns immediately; poll `status`. A push request reads `pushing`
from its pass until it lands, so polling ends at `pushed`, `held` or `partial`; one
that rests at `passed` never started landing, and `push UUID` lands it.
`hold` requires `minutes`.
The [API client](../packages/api-client/src/index.ts) exposes `integrate`.
The [local-bare-repo integration tests](../apps/clankie/test/integrate.integration.test.ts)
exercise the gate and landing boundary without a live origin or live full check.
