# Case B: Astra and Terra leading a fleet on VUH-1115

Initial samples: **2026-09-04 20:54–20:59 America/Chicago** (2026-09-05 01:54–01:59 UTC) ·
[VUH-1107](https://linear.app/vuhlp/issue/VUH-1107/compare-astra-and-terra-on-four-complete-clankie-jobs)
· job: VUH-1115

Baseline `7afff479`. Each arm ran against its own isolated service on `127.0.0.1:4410`, with
its own config, state, cache, Herdr and bearers. The owner's live service, model selection,
Herdr fleet and Keychain were never written.

## Current result: no usable comparison

| Later Terra attempt  | Observed                                                                            | Limit                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Whole-job observer   | Initial turn 62.476s; quiescence at 817.194s; five captain runs; no blocked workers | Implementation destroyed before the frozen check; correctness and complete harvest unverified |
| After capture repair | One empty captain turn; frozen check red                                            | No usable model sample; no error cause preserved                                              |

The [five-turn receipt](evidence/2026-09-04-harness-fault/job-terra-destroyed-arm.json)
proves watch-driven continuation live. Measuring its first turn alone would omit
over 92% of the observed duration. Quiescence alone does not prove that the
captain inspected every worker result.

The lead edited the running shell script after its brief was consumed. The brief
bytes were safe, but Bash resumed at a stale byte offset and misparsed the rest.
Cleanup then removed the uncaptured worktree. The [transcript and worker screens](evidence/2026-09-04-harness-fault/)
survive; the implementation and its verification result do not.

The flow now executes an immutable snapshot. Cleanup retains worktrees until both
full and source-only binary diffs are captured, including new files and worker
commits. Abnormal exits cannot report success. `flows/check-capture.sh` exercises
full recovery, test exclusion and failed-capture retention in disposable Git repos.

The [next empty turn](evidence/2026-09-04-usage-limit/run-terra-empty-completion.json)
has no assistant message or tool call. Its [frozen check](evidence/2026-09-04-usage-limit/check-terra.json)
is red. Probes five to seven minutes later reported subscription limits through a
different transport; that does not establish this turn's cause. The cause remains
unknown. Paid runs are paused, with three Terra attempts and one Astra attempt
consumed overall. Astra has no attempt under the corrected job boundary.

Historical job receipts contain `succeeded: true`, meaning observation reached
quiescence. That is not a requirement result. The observer now calls the field
`settledUnblocked` and flags a captain that starts no worker and takes no further
turn as `producedNoWork`. The frozen check remains the correctness gate.

## Verdict: the measurement was wrong, and these runs measured the wrong thing

**Retracted.** This page first said both arms "failed to do the job" by settling while workers
ran. That verdict was invalid, and so was the requirement it rested on.

Clankie is a persistent agent. `herdr_watch` arms a persisted one-shot watch, and when the
watched pane settles `HerdrWatchStore` wakes **the same operator conversation** through
`submitInternal(conversationId, prompt, "watch")`. The shipped tool description says so in as
many words: _"When the agent settles, this same operator conversation wakes so you can inspect
and harvest it… do not poll with schedule_wake or block the current turn."_ An initial turn
ending after dispatch is the architecture working, not a violation.

The frozen requirement said _"do not settle while a worker is still running"_ — which
contradicted the product's own documented mechanism. Both captains followed the product. The
requirement was the error, and it was mine to catch before spending the runs.

**Both arms armed every watch successfully.** Six of six `herdr_watch` calls returned
`"outcome": "watching"` with real watch ids against the correct panes in the correct private
session. Then the harness tore the workers down about fifteen seconds later, so no watch could
ever fire.

These runs therefore record **initial-turn latency only**. They are kept byte-exact as an
_initial-turn sample truncated by harness_, and they say nothing about whether either arm would
have completed the job.

## Results

|                                      | Terra                                   | Astra                                       |
| ------------------------------------ | --------------------------------------- | ------------------------------------------- |
| Selection (CLI, pre-run)             | `openai-codex/gpt-5.6-terra` @ `medium` | `openai-codex/gpt-6-astra` @ `medium`       |
| Configured context window            | 272,000                                 | 272,000                                     |
| Turn wall clock                      | 66.6 s                                  | 105.0 s                                     |
| Settled phase                        | `completed`                             | `completed`                                 |
| Tool calls (`turn-settled`)          | 11 — bash 6, herdr_watch 3, read 2      | 12 — bash 7, herdr_watch 3, read 1, write 1 |
| Context tokens at settle             | 58,551                                  | 58,684                                      |
| Operator interventions               | 0                                       | 0                                           |
| Workers started                      | 3                                       | 3                                           |
| Worker status at settle              | all three `working`                     | all three `working`                         |
| Source written **at initial settle** | none                                    | none (one scratch notes file)               |
| Watches armed                        | 3 of 3, all `"watching"`                | 3 of 3, all `"watching"`                    |
| Frozen check at that instant         | red — but the job had not run           | red — but the job had not run               |

Both arms were pinned to the **same configured context window**, 272,000, through the public
provider-override surface (`provider.openai-codex.models.<id>.limit.context`). That declares a
budget below what the transport allows rather than asserting a false capability, so the two
runs differ only by model. Case A's confound is removed here.

### What each captain did

**Terra** — initial turn 66.6 s. Started `capture` (`w1:p1`), `surfaces` (`w1:p2`) and
`reviewer` (`w1:p3`), armed a watch on each (`cd489c3a`, `8c399af1`, `55ea3b27`), and reported
_"all three are being watched for harvest."_

**Astra** — initial turn 105.0 s. Started `capture` (`w1:p2`), `surfaces` (`w1:p3`) and
`reviewer` (`w1:p4`), armed a watch on each (`78586054`, `161ca316`, `9e46ab68`), and reported
_"Completion watchers are armed; implementation and verification are not finished."_

**Both reports were accurate.** An earlier version of this page claimed Terra's wording
"implies an arrangement that did not exist" and scored that as a reporting-accuracy difference
against it. That was invented: the watch ids in
[`evidence/run-terra.json`](evidence/run-terra.json) show the arrangement existed exactly as
described. The claim is withdrawn, and no reporting-accuracy difference between the arms is
supported by this evidence.

### The fleet was correct

Both arms honoured the fixed worker setup exactly, and the worker panes say so themselves:

```
▐▛███▛█   Claude Code v2.1.261
▝▜██████▀  Sonnet 5 with medium effort · Claude Max
  ▝▝ ▝▝    ~/.cb-<arm>/wt-<arm>
           ⏵⏵ auto mode on
```

Two implementers and one reviewer, `claude-sonnet-5`, medium effort, auto mode, each in that
arm's worktree and that arm's private Herdr session (workspace `w1`, never the owner's `w1K`).
All three were 11–12 seconds into their first response when their captain settled. Teardown
harvested their status and screens before stopping the service that owned their Herdr, then
closed them.

## A harness fault that made the first verification worthless

The check resolved `tsx` at the worktree root. `tsx` is a devDependency of the apps, not of
the workspace root, so a freshly installed worktree has no `node_modules/.bin/tsx` — every CLI
check failed with `ENOENT`. That has two consequences worth stating plainly:

- **The baseline red gate passed for the wrong reason.** It only requires the check to fail,
  and a check that cannot run always fails. It certified nothing.
- **Both post-arm checks were vacuous**, so the first reported "12 of 13 failed" was not
  evidence about either arm.

Fixed by resolving `apps/tui` → `apps/clankie` → root, and by making the resolution its own
`harness.*` check. The flow's baseline gate now **rejects a red caused by a harness failure**
rather than accepting it. Re-verified afterwards from the preserved `source-only-<arm>.diff`
artifacts against a properly installed baseline worktree — keylessly, with no paid rerun. The
baseline now fails for the right reason: `clankie metrics` is not a headless command, so the
launcher answers `the TUI requires a TTY`.

That check is therefore not evidence about either arm either. What git does show is narrower
than the original claim: at the moment of the **initial settle**, Terra's `source-only-terra.diff`
was empty and Astra's held one untracked notes file. That is a snapshot taken seconds into a
delegated job, not a verdict on it.

## The continuation mechanism, proven

Verified keylessly against the exact baseline these arms ran on (`7afff479`), using tests that
ship with the code:

```
apps/clankie/test/herdr-watch.test.ts
  ✓ persists one event-driven wait and wakes the same conversation when it settles
  ✓ re-arms a persisted watch after restart using the stable terminal id
```

A watch persists to `<state>/herdr-watches.json`; when the watched pane settles the store calls
`wake(conversationId, prompt)` carrying the harvest reason and the agent's status, and
`captain.ts` turns that into `submitInternal(conversationId, prompt, "watch")` — a fresh captain
turn in the same conversation. `tools.ts` arms it against the running conversation. This code is
identical at the baseline and at HEAD.

So the mechanism was present, correctly targeted, and armed six times out of six. **What the
early teardown prevented is measurement, not completion**: the workers were closed about fifteen
seconds after each initial settle, before any of them finished, so no wake could fire. Whether
either arm would have completed the job is unknown, and this evidence cannot say.

## The corrected boundary

The job is judged when it goes quiet, not when its first turn ends:

> Success requires the frozen acceptance checks green, every required worker result harvested by
> the captain, and no unfinished owned delegated work. Quiescence means no registered watch, no
> owned worker in a non-settled state, and no captain run in flight. Failing to reach that inside
> the 45-minute **job** budget is failure.

`apps/clankie/scripts/comparison-await-job.ts` observes exactly that, from state the service
already keeps, and **sends nothing** — no nudge, no resume prompt, no second brief. Clankie's own
wake mechanism does the work. It shares one transport (`comparison-dispatch.ts`) with the run
driver and shapes every op through `createOperatorConversationServiceClient`, so the envelope is
parsed by the maintained protocol client rather than by hand.

An observation it cannot make is **unknown, never zero**: a failed Herdr listing or an
unparseable watch file fails the job closed with the reason on the receipt. Only a watch file
that has never existed counts as "none armed".

`pnpm --filter @clankie/clankie comparison-check-loop` proves it — **30 checks, no service, no
credential, no model call**, with the HTTP half driven through the real `createClankieApp`
router and the real dispatch envelope:

```
the real app's envelope parses through createOperatorConversationServiceClient
an operator bearer is refused on the captain-guarded dispatch route
a dispatch past the deadline is refused before sending
a watch file that never existed is a known zero
a corrupt / shapeless / unreadable watch file is unknown, not zero
a failed or non-JSON worker listing is unknown, not an empty fleet
an initial turn settling while a worker works is not terminal
latency is measured from the job's real start, not from the watcher attaching
a continuation admitted after the watch cleared is not missed
the job is only called done once the continuation is settled too
unfinished delegated work with no watcher fails, and names it
an unknown observation fails closed, and says which one
a blocked worker is reported, not silently counted as finished work
a deadline is a failure that keeps its evidence
every malformed argument set is refused
```

The continuation _mechanism_ itself is proven separately by the shipped baseline tests above;
the checks here exercise the observer, and none of them claims to be that integration.

The requirement's fleet wording is corrected to match the architecture: ending a turn after
dispatch is expected, and the job is done when every worker's output has been harvested and no
delegated work is left running.

## Measurement limits

- **Usage and cost remain unavailable.** That is precisely what VUH-1115 exists to fix, and
  neither arm reached implementation before the harness stopped it. `contextTokensEnd` is
  context occupancy at settle, not usage.
- **The initial runs are not a whole-job result.** They are an initial-turn sample, truncated by the
  harness. No completion, quality or ranking claim can rest on them.
- **Subscription is not zero economic cost.** Both arms, and six Claude Code workers across
  them, consumed real capacity for a measurement that turned out to be the wrong one.
- The initial batch has one attempt per arm, one effort tier and one brief. Later
  harness failures are recorded above and provide no additional comparison sample.

## Reproduction

```bash
# Keyless observer and capture checks:
pnpm --filter @clankie/clankie comparison-check-loop
bash docs/testing/2026-09-04-case-b-execution-metrics/flows/check-capture.sh

cd docs/testing/2026-09-04-case-b-execution-metrics/flows
./run-arm.sh --arm terra --root ~/.cb-terra --check      # prerequisites only, starts nothing
# Paid arms: resume only after the transport is available.
./run-arm.sh --arm terra --root ~/.cb-terra
./run-arm.sh --arm astra --root ~/.cb-astra
```

`--root` must be a new absolute directory, one per arm. The flow refuses to proceed unless the
frozen check is red at the baseline **and** its own `harness.*` checks are sound, pins both
arms to 272,000 context, asserts the private Herdr socket, harvests workers before stopping the
service, and verifies the arm's non-test source alone on a pristine baseline.

Frozen input SHA-256 values remain identical across arms:

- `requirement.md.txt`: `ee415616e34b8608926c0ef613d9c630305a8b7b1350ba425ebba153fee71765`
- `check-arm.mjs`: `f5a78ab7ddc9c8ce47d48bc349b4bcd402449f0f2ca6f1be5f4307ddf42c7455`

The check runs standalone against any worktree:

```bash
node flows/check-arm.mjs --worktree DIR --state DIR [--base URL --token-env NAME]
```

## Evidence

| File                                                                                  | What it holds                                                    |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [`evidence/summary.json`](evidence/summary.json)                                      | Both arms' timing, counts, settle phase and final message        |
| [`evidence/workers-at-settle-*.txt`](evidence/), [`evidence/worker-*.txt`](evidence/) | Worker identities, status at settle, and their own final screens |
| [`evidence/run-*.json`](evidence/)                                                    | Full durable conversation transcripts                            |
| [`evidence/source-only-*.diff`](evidence/), [`evidence/touched-*.txt`](evidence/)     | Exactly what each arm wrote                                      |
| [`evidence/turn-settled-*.jsonl`](evidence/)                                          | The service's own settled-turn line per arm                      |
| [`evidence/selection-*.json`](evidence/)                                              | The pinned selection each arm ran under                          |
| [`evidence/requirement-sent-*.md.txt`](evidence/)                                     | The brief as each arm received it                                |
| [`flows/requirement.md.txt`](flows/requirement.md.txt)                                | The frozen requirement, identical for both arms                  |
| [`flows/check-arm.mjs`](flows/check-arm.mjs)                                          | The frozen external check                                        |
| [`flows/run-arm.sh`](flows/run-arm.sh)                                                | The runnable flow                                                |
