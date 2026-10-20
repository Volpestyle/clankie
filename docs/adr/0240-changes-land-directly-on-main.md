# ADR 0240: Changes land directly on main

Status: Accepted (James, 2026-10-07). Retires the mandatory landing queue in
[integration](../integration.md); `clankie integrate` remains an optional tool.
Amended 2026-10-10 for gate revalidation (VUH-2024) and timed deploy holds
(VUH-2049).

## Context

Every clankie and clankie-app landing was required to go through
`clankie integrate`, which composed a batch and ran the full `pnpm check`
before pushing `main`. By 2026-10-07 none of the 15 recorded batches had
landed: seven failed their gate, five conflicted, and the rest waited 20–80
minutes for shared heavy-check slots. A batch with no commits failed too,
because `main` itself fails the full suite (137 of 7,211 tests). Meanwhile 228
commits reached `main` directly, so the queue guarded nothing while delaying
every change that obeyed it. A full suite per landing also contradicts the
owner's standing rule that per-change checks stay fast and narrow, with full
suites for releases and explicit manual runs.

## Decision

Agents and the owner commit to `main` and push it directly:

1. Stage only your own files.
2. Commit, then `git pull --rebase origin main`. Resolve conflicts only in your
   own files; coordinate with the owner of the rest.
3. Run the repository-root `clankie heavy -- pnpm check:landing`, with its own
   `--changed` selection against fetched `origin/main`, then `git push origin main`.
   Focused checks are for iteration, not a substitute for this gate. A source
   change after checking requires another root gate (ADR 0247). A base change
   alone does not when `pnpm check:landing --revalidate` passes (amended
   2026-10-10, VUH-2024): the gate records what it checked (the change's files,
   the modules its selected tests imported, and the compiler inputs of every
   file the change affects), and revalidation keeps the result only when the
   incoming commits touch none of them, change no repository-wide configuration
   or gate script, and delete nothing. Anything else exits 1 and the gate reruns.
   Without an explicit base the gate checks the commit HEAD sits on (its
   merge-base with `origin/main`), so a ref moved by another worktree's fetch
   cannot make it check a base HEAD lacks; revalidation covers the newer base.
   Dependency changes land the same way, with no main hold (amended
   2026-10-10, VUH-2044). A lockfile change counts only for the workspace
   packages whose resolved dependencies changed (their own entry, or anything
   in their resolved closure), which are checked as if their manifest changed.
   Because a changed `package.json` makes Vitest rerun every test, the gate
   also records which of those tests can see the change: ones that load a
   changed file or compile against it, plus any outside the compiler graph.
   Revalidation checks incoming commits against those. Root dependency fields,
   `pnpm-workspace.yaml`, compiler configuration, and a lockfile the gate
   cannot read with certainty still typecheck everything, and any base move
   then reruns the gate. An incoming lockfile or manifest commit is
   repository-wide for everyone else's revalidation.

If the root gate's only failures are unchanged timing-sensitive cases outside
the change and its affected imports, the lead may accept the landing after
every exact failing case passes in isolation on unchanged test/product inputs.
Retain the gate's real nonzero exit, exact errors, load samples and isolated
results, labelled **Full-gate result** and **Isolated passes**. This is a lead
acceptance decision, not a green full gate. Failures in changed code or affected
consumers still block; do not weaken assertions, timeouts or product defaults.

The full `pnpm check` runs for releases and on request. `clankie integrate`
stays available for anyone who wants a composed, gated batch, but nothing
requires the queue. The root landing gate is required for direct pushes.

### Deploy holds protect the running service, not main (amended 2026-10-10, VUH-2049)

A deploy hold (`clankie integrate hold`) keeps runtime updates from replacing
the running service while someone relies on it, such as a live test. It does
not hold `main`: direct pushes and `clankie integrate --push` go ahead whatever
holds exist, and pushing never deploys. Each hold names its minutes, at most 60,
and lifts on its own at expiry with a receipt naming the holder. The lead or
owner may release anyone's hold with an audited actor and reason. Fleet status,
the lead's round and `update` refusals show every hold's holder, age and time
left. The runtime canary's own holds end with their canary instead.

Holds used to block deploys and integrate pushes but not direct pushes, so
holders believed `main` was frozen when it was not. On 2026-10-10 a release hold
said "~30 min max" and blocked every deploy for over 90 minutes. During another
hold, three direct pushes landed under the holder's gate anyway. Making pushes
honour holds was rejected for four reasons:

- Direct pushes come from many worktrees and from remote machines that cannot
  see this Mac's registry.
- A client hook is skippable, and a check inside the gate races a hold placed
  after it.
- Freezing `main` for one seat's gate stalls every other seat, which this ADR
  exists to avoid.
- Since VUH-2024, `check:landing --revalidate` keeps a gate whose inputs the new
  commits did not touch, and `clankie integrate` composes on fresh origin for
  anyone who wants a serialized batch.

So landing gives way to nothing, and holds guard only deploys, for a bounded
time.

## Consequences

- With many seats landing, `main` moved under almost every gate and green
  results were discarded (VUH-2011 passed three times and pushed none; VUH-1950's
  second commit gated four times to push once). Revalidation keeps those results
  when nothing they checked changed. Both sides passed their own gates, so a
  merged result can only differ where a check depends on files from both; the
  residual risk is a check that reads files outside its import graph, the same
  blind spot `--changed` already has.

- Fixes reach `main` after their root landing gate passes; focused checks support iteration.
- A change that breaks something outside its own checks is not caught until a
  release or manual full run. Restoring a green full suite is separate work.
- Concurrent agents in a shared checkout must commit only their own files and
  rebase before pushing; a separate worktree avoids disturbing others'
  uncommitted work.
- A forgotten or overrunning hold delays deploys for at most an hour. A holder
  that needs longer places a new hold, which shows up as a new decision with its
  own receipt.

## Integration batches protect their own runtime (VUH-2534, 2026-10-20)

Runtime cutovers repeatedly terminated gate runners with exit 143 and no completion
receipt, including deferred source updates reaching `dueAt`. Each manual resubmit
lost 15–20 minutes. Depending on the lead to place a hold before every batch
leaves a race and cannot coordinate a deferred update's deadline.

The integration queue now acquires a service-owned deploy hold for each active
attempt before composition, and releases it after gating and any push have
settled. It uses the same registry, lock and expiry receipts as manual holds,
names the batch UUID in update status, and expires after sixty minutes without
renewal. Gate isolation and remote fallback remain inside that attempt's hold.
A deploy waits outside the registry lock for automatic holds, so batches can
finish and status stays readable. Manual and canary holds retain their explicit
refusal and audited override semantics. Explicit owner overrides can still
interrupt a batch.

An immediate update waiting on these holds returns HTTP 202 promptly, with
`waitingForIntegration` and a pending intent UUID, instead of timing out its
thirty-second CLI request. The private `updates/integration-wait.json` survives
service restart; the service retries admission every fifteen seconds under the
same hold lock. Status shows the intent, and `update cancel` removes it. Ordinary
and canary holds are checked again; prior overrides are never silently reused.

A waiting deploy fences admission of another attempt. Once the updater accepts
it, its pending operation keeps that fence until the runtime is replaced or the
operation settles. Thus an update admitted before a new batch cannot restart
under its gate, and an unending queue cannot starve the update. Queued approved
work is recovered by the next service instance. This applies to immediate
updates and deferred updates even after their deadline; `dueAt` never overrides
a batch's bounded protection. Expiry bounds how long a stuck gate holds deploys.

Accepted requests retain their exact approved commit objects and opt into restart
recovery. An interrupted request gets one durable automatic retry, shared across
process restarts and independent of failed-gate isolation. The original request
UUID follows its fresh attempt, retaining old logs and commit stores. Startup
recovers under the exclusive queue lock, releases only the old automatic holds,
and uses the previously admitted approval, never a new caller's authority.
Historical requests without recovery metadata remain inspection-only. Shutdown
stops queue draining before closing the governor, leaving an interrupted batch's
retry queued for the replacement service rather than spending it in the outgoing
process.

Composition fetches remote main again before applying the same approved objects.
Landing reads the remote ref before sending, records an already-present candidate
without another push, and keeps the existing uncertain-push reconciliation rules.
This covers a push whose receipt was lost during restart. A second interruption
stops for review; recovery and exhaustion notify the lead through runtime health
notices. Neither retries nor holds deploy a runtime or change review authority.
