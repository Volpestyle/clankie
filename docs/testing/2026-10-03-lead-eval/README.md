# VUH-1474 lead replay preparation

Status: **PARTIAL — native execution integration blocked, no lead trials run**.
The pinned task set and deterministic preparation/evidence tooling are built.
The interactive runner, candidate grading and complete native accounting are not
finished. James's run decision alone cannot close those engineering gaps. This
issue must not be marked Done. Base: `b7c67ac9`.

## Pinned historical sources

| Task                                 | Pre-fix commit                             | Landed fix                                 | Held-out files |
| ------------------------------------ | ------------------------------------------ | ------------------------------------------ | -------------- |
| Roles, native subagents, work labels | `bbb1b551ee230b1f2cd4fe4c9c9b7167e7c68e1b` | `1b779a1157beed91bd8adf013f08c799eddf02b5` | 9              |
| Owner attachments                    | `2e6cf7a7f5a952bd2c82cea6e142eced6569e8d6` | `6d1f7b13c0b9387cb072c0b97983b5a670d673f6` | 2              |
| Async Discord text                   | `d10d11a7a9e7e6828bfc9eba3a42cc975be7a878` | `aa015e0eba4e5f1487ada359fedbaa62069b27dc` | 3              |

The [manifest](../../../scripts/evals/lead-tasks.json) retains full source trees,
prompts/hashes and test blob/SHA-256 provenance. Tests are whole unmodified files
from their landed commits, held outside agent worktrees. The roles and attachments
after references pass 74 and 11 tests respectively; their pre-fix references fail.
The selected async references pass 35 tests after and fail before.
The [reference record](reference-checks.json) retains grader and log hashes.
These are deterministic source/grader checks, not agent results. Preparation
exports only pre-fix source into a new repository, removes held-out tests and
historical eval evidence, and gives workers separate indexes/worktrees.

The async commit also contained unrelated Swarm diagnostics and `state_work`
changes in `app-smoke.test.ts`. That whole test file failed even on the landed
reference (an owner-settings read and an unrelated protocol mismatch). It is
excluded, with exact provenance and reason retained in the manifest. The three
selected files exercise async service handling, the client polling API and the
durable bridge inbox. This selection was made before any model trial. Grader
environments must use the explicit fixture HOME/settings/state recorded in
`lead-grader.json`, not inherit live service or account configuration.

## Neutral pins and constraints

The official [Terminal-Bench v4.0.0 source](https://github.com/harbor-framework/terminal-bench/tree/452bf305c6daa62fc59061d22133a7cbc7c1572e)
was cloned read-only for source inspection. `html-js-filter` and
`photonic-waveguide-routing` have task-tree and per-file hashes in the manifest;
the Apache-2.0 license hash is retained. Their agent timeout is eight hours and
the verifier environment is separate. Source is pinned, but container images and
native fleet execution are neither installed nor verified. No benchmark task ran.
The historical one-hour tasks are the only supported preparation plans.

## Deterministic behavior and remaining implementation

Focused tests cover provenance/tamper refusal, equal task/time budgets, arm-order
rotation, no run implication, independent worker indexes and no future commit
objects/remotes, identical before/after graders, stale/ambiguous/unknown/exhausted
account-window stops, all-agent token de-duplication and unknown-cost handling.
Dry planning performs no auth/account probe. The `run` command always refuses
before spawning anything. The runner is not added to CI, checks, timers or
post-reset dispatch.

The [run guide](../../evals.md#lead-replay-preparation-vuh-1474) lists exact gaps.
In particular `packages/agent-transcript/src/subagents.ts` reads at most a 2 MiB
cold tail and remembers 64 calls for a display summary. It has no complete token
or account ledger. `createClaudeWorkerSeatAdapter` supplies channel/receipt/stop-hook
control for actual interactive workers, but this preparation tool does not yet
bind a sandboxed throwaway service/Herdr session to those native controls.
`windowGuard` is a pure function; it is not a continuous enforcement process.
Normalized imported evidence is labeled `imported-unverified`, never promoted to
proof of real hiring or complete usage coverage. No generic callback or fake
fleet is claimed as the real arm. ADRs 0207 and 0213 apply; Swarm is not restored.

No account probe, model trial, live fleet change, grant, owner approval, restart,
production action, full round or recommendation was performed. The historical
106/110 Codex seat-suite harvest remains inconclusive and unchanged.

## Native-runner continuation

The continuation adds candidate-diff preparation and a manual sandboxed grader.
It remains **partial engineering**, not a built native runner awaiting approval.
The grader applies retained binary diffs to trusted pre-fix trees, retains patch,
tree, test and dependency hashes, rejects validation-tooling changes, and invokes
only the fixed held-out Vitest command through the existing network-off macOS
sandbox. Dependency directories must be independent copies inside the disposable
workspace; external dependency links fail closed. No dependency install occurs.
A structured verifier report must prove complete execution of every pinned file
and expected assertion count; exit zero without that evidence is not a pass.
Counts reconcile pinned test declarations with the retained 74/11/35 reference
totals. Missing reports, empty coverage, skips, partial files and duplicate suites
fail closed, and the report/reference content hashes are retained.
Deterministic tests use fake verifier process results and disposable repositories;
they are not benchmark results or proof of a live native run.

`run` still refuses before any launch/probe and now emits exact machine-readable
gaps. Claude's native seat control cannot programmatically interrupt a turn or
close its process; the subagent reader intentionally truncates history; native
seat events expose no complete account-bound subscription window or descendant
usage ledger. The real hire path exists but an isolated service/fleet containment
adapter remains unwired. Official Terminal-Bench source pins remain unchanged;
no native container/verifier integration is claimed.

A follow-up needs an owned process boundary that can terminate every descendant,
a provider-supported complete session/account usage source, and child-admission
checks that cannot start unaccounted spend. Only then can an isolated service and
Herdr adapter safely reuse the real hire path. These are separate from the owner
run hold. No production contracts, live fleet, accounts, grants or owner state
were touched. The issue remains In Progress and requires an authorized actual
round before its acceptance criteria can be satisfied.

Frozen-source full-check and focused logs for this continuation are retained
outside the public repository under the session's VUH-1474-native evidence folder.
