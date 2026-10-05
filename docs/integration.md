# Approved commit integration

`clankie integrate` lets the service compose and gate an ordered batch of already
approved commits. The caller owns review and approval. The service must run from
a source checkout with Git and pnpm available; installed release and hosted
clients do not expose this local repository operation.

```bash
clankie integrate CORE_SHA CORE_SHA --app APP_SHA --push
clankie integrate CORE_SHA --id UUID --no-wait
clankie integrate status UUID
clankie integrate push UUID
clankie integrate revert PASSED_BATCH_UUID --push
```

Core inputs are positional; repeat `--app SHA` in order for the optional app.
Core may be empty when only app commits are supplied. The service uses its own
checkout and the sibling `clankie-app` checkout. Each batch clones their Git
objects independently, fetches current `origin/main`, and creates detached
`clankie`/`clankie-app` worktrees beside each other so the app resolves core's
protocol. It never switches or installs in either live source checkout.
Every input records its full SHA and applied/already-present/conflict/failed
result. After a conflict, later inputs for that repo are blocked; files and
conflict details remain in the batch for inspection. Repair by approving new
commits and composing a fresh batch.

The service serializes batches. Each runs real `pnpm install --frozen-lockfile`
with a private store and copied packages, then `pnpm check` in every included
repository. Evals remain outside the full check. Gate processes start with private
HOME, XDG directories, Clankie state and fleet descriptors, and a file credential
broker, before any Vitest setup can snapshot owner paths. Their environment has
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
then app. It does not deploy or restart the live service.

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

## Deploy holds

```bash
clankie integrate hold --holder 'Bram w3Z:p2N' --pane w3Z:p2N --reason 'live test'
clankie integrate holds
clankie integrate release HOLD_UUID --actor James --reason 'test finished'
clankie integrate push BATCH_UUID --override-hold HOLD_UUID --actor James --reason 'ship now'
clankie update --override-hold HOLD_UUID --actor James --reason 'test may end'
```

A hold records its holder, reason, creation time and optional `--pane` or
`--seat`. Use fleet-qualified IDs for remote holders. Status reports `present`,
`gone`, `unknown` (unavailable census) or `person`. A gone holder is visible but
still holds; holds never expire automatically. Landing and runtime-update
admission share the durable registry and lock. This also protects the machine
session's runtime-update tool. Existing admitted deployments are not cancelled
by a later hold.

Only the authenticated operator can override, explicitly naming **every** hold
with `--override-hold` plus `--actor` and `--reason`. The actor is an audit label,
not authentication. Overrides are durable events and leave holds in place.
Releases also retain who and why. Runtime-update status includes current holds.

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
`run` takes a caller-created UUID, core/app arrays, optional `restore` batch UUID,
`push` and explicit hold overrides. It returns immediately; poll `status`.
The [API client](../packages/api-client/src/index.ts) exposes `integrate`.
The [local-bare-repo integration tests](../apps/clankie/test/integrate.integration.test.ts)
exercise the gate and landing boundary without a live origin or live full check.
