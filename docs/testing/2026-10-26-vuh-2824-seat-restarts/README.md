# VUH-2824: hired-seat source restart proof

This records source and isolated fixture evidence. Installed-harness acceptance
and whole-issue completion remain open under GLOBAL. The original checkpoint
`66df219433d19ef1de0daaa8556507dedaf03fd3` was imported into the fresh successor
tree as `d1cd38bb7`; its branches and trees remain untouched. The original
150-test author result was not accepted: independent review reproduced 149/150,
and candidate `e07602cb` received CHANGES. The older evidence object remains in
the manifest for that history.

The successor fixes the three required findings and the trust/account audit:

- Fresh all-UID PID/PPID/UID ancestry crosses non-owned parents; exact birth reads
  target the private journals' owners, runners and descendants. Known unrelated
  sibling branches continue even with an unobservable higher ancestor. Missing
  identity or ancestry, UID/PPID disagreement, and changing journals refuse.
- Native adapter and ordinary hire admissions finish before signal: current
  maximum trust, signed-in account identity/key/canonical home, usage without an
  old one-shot override, project/tools and resources. Ordinary hires are tested
  without `NativeLaunchPolicy`. Successor guards enforce revocation and shutdown;
  benign owner activity, setting changes and resource pressure do not strand an
  admitted successor. Post-signal failures immediately notify and never replay.
- A definitely superseded kept handoff retires into history with its receipt and
  recovery inputs. The next eligible sweep requests one new nonce. Outstanding
  sends/effects take precedence over supersession and cannot be retried.
- Four fail-closed read catches have explicit explanations accepted by the
  existing swallowed-rejection checker; the checker is unchanged.

Focused governed checks passed **181 tests across seven files**: native engine
42, policy 16, resource guard 3, existing Claude/Codex adapters 87, and settings /
CLI 33. The native engine uses real owned stand-in subprocesses and a surviving
shell, including original control cleanup, predecessor CAS, admission refusals,
account/trust changes, revocation, uncertainty and non-replay. Fixtures isolate
HOME, XDG and harness homes. Policy tests use native transcript shapes, real
handoff files and an authenticated Hono status route; their tracker is a file
stand-in. Resource tests use real native ancestry and private registry journals,
including all resource lanes, simulator phases, and cross-UID ancestry topology.
Source typecheck and the unchanged swallowed-rejection check also passed.
Commands, complete retained outputs, source digests and prior failures are in the
new `repair-source-proof.json` evidence object.

The next exact review, candidate `4926d140`, also returned CHANGES. Its five
required corrections are retained with red/green evidence in the new
`review-repair-proof.json` object. A real orphan holding a lease now refuses at
PID 1; exact journal births are checked again after ancestry. Claude consumes
one successful consent admission only for its exact successor launch object.
Fresh-restart usage admission applies even when the original hire resumed a
saved session, and remains pinned to the original account. Failed recovery-file
or tracker reads after a good reply were reproduced leaving `requested`; they
now become uncertain and immediately notify once, retaining the original receipt
without resending or signalling. Both strict OpenAPI fleet schemas now include
`seatRestarts` and the nearby existing gate fields. Release notes explicitly say
the setting defaults to on for existing installations. Earlier passing checks
and evidence remain historical source proof, not review approval.

R3 governed regressions passed **160 tests across six files**: native engine 43,
Claude adapter 63, policy 17, resource guard 4, and settings/CLI 33. Red runs
reproduced the orphan/PID-reuse gaps, the consent reread, the resumed-hire usage
bypass and four post-reply proof-read failures before their fixes. Public docs
rendering and an explicit parse of both strict OpenAPI fleet schemas passed.
Service source and all 15 test typecheck partitions, the resource package
typecheck, and the unchanged swallowed-rejection checker also passed.
The retained logs are under `.local/vuh2824-r3/` in the owned tree and in the
`review-repair-proof.json` evidence object. The unchanged Codex adapter suite's
prior result remains valid; no installed harness restart is claimed.

The 500K native backstops remain covered by adapter assertions. The original
source audit verified installed Codex 0.163.0 keys against its version-tagged
configuration and Claude 2.1.310 support. Native compaction was not forced.
Remote and prepared command-pane fresh restarts remain unsupported; loss of
original native control after service replacement refuses. Unknown facts and
uncertain originals never authorize fallback dispatch.

VUH-2825 must land first; the final VUH-2824 rebase, exact Elin review and normal
root gate/revalidation follow its landed SHA. The final issue report records
those outcomes separately from these focused checks. Mika owns the activity
producer; his tree was not edited. GLOBAL retains the main-window push decision,
runtime rollout and closure.

Required installed acceptance remains GLOBAL-held: an authorized real Claude
worker restarts mid-deliverable, preserves its handoff, demonstrates its fresh
first-call context, then lands its work. These source fixtures do not substitute
for that proof. No live service/worker/harness restart, plugin reload, account /
settings / credential change, deployment or eval was performed.
