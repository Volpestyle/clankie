# LOCAL-VUH-8: retirement preserves tracker identity

Tracks: `LOCAL-VUH-8` (`7bf73956-fe04-496c-9b07-9d226d7125c1`), builtin Clankie Work `cbd205ab-cad4-48b8-9724-7109410fc921`.

The source keeper now retains full canonical keys and immutable issue UUIDs,
uses the verified hire's current saved tracker scope, and refuses changed,
missing or ambiguous attribution. UUID and human-key aliases share ownership
within one scope; another store's identical display key cannot inherit a write.
Builtin completion remains behind its existing owner and evidence gates.

## Inspected proof

`seat-issue-scope.integration.test.ts` uses real disposable tracker/evidence
stores, production project routes, the production native-attribution capture
helper, the production keeper and real hire-ledger reconciliation. The native
process observation and recovery-release entries are explicitly **synthetic
helper fixtures**, not live native panes. Its Linear compatibility case reaches
a real disposable HTTP OAuth/GraphQL provider validating the provider schema;
it does not reach connected Linear.

- Correct `LOCAL-VUH-4` receives the Paused/Todo status and retirement comment.
- Automatic observed exit settles that same scope after real ledger reconciliation.
- Separate stores with identical `LOCAL-VUH-4` keys have independent status,
  successor ownership and pause restoration. Key/UUID aliases share ownership.
- A disposable default store's synthetic `VUH-4` sentinel and imported frozen
  source-record graph remain byte-for-byte unchanged. No real frozen copy is used.
- Missing attribution, multiple issue keys, stale roster occupants, pending native
  sessions, removed projects, workspace overlap, replacement allocations and
  recovery-release attribution refuse without wrong-target writes.
- A current scope switch to another store with the same display key refuses
  because the original UUID does not exist there.
- Missing connected Linear refuses without local compatibility fallback. Bound
  and legacy saved Linear projects retain legitimate status/comment behavior
  through the disposable provider.
- Actual evidence blobs and independent fixture checks gate delivery. Accepted
  and delivered-worker Done attempts refuse `owner_verification_required`;
  the retained writer is agent-worker Clankie acting for the owner.

The existing six retirement integration checks remain relevant and passed.
Focused compiler, touched-file format/lint and final test output are retained
with `proof.json`, `linear-proof.json`, `focused-tests.log`, `typecheck.log`,
`format.log`, `lint.log`, and `review.md` in the evidence-store archive. The
archive also retains the checked source diff, source hashes, commands, scoped
compiler config and compiler report. Only this README and its evidence receipt
are committed.

## Original deployed regression

`regression-receipt.json` separately retains the observed receipt supplied in the
assignment: at `2026-10-12T21:36:42Z`, retiring Iris `w4M:p1` closed the correct
pane but settled `VUH-4` as `Already Canceled`. Its provenance is the lead's
reported production observation; this worker did not repeat that retirement.

## Limits and handoff

No real Linear writes, live keeper-ledger edits, owner/main or sibling-tree
mutations, deployment, restarts, or other people's pane retirements occurred.
The worker pane stays alive after the run/lease handoff.

The independent native review inspected the actual diff and boundary proof.
The global integrator owns the composed exact-tree root landing gate; the global
lead owns deployment and the safe installed-path check. This evidence does not
establish installed native discovery or live connected-account churn. Unscoped
operator-head/native-child daily ownership claims are deliberately excluded until
tracker attribution is available. No owner-verification or Done claim is made.
