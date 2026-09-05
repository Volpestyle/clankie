# Case A: Astra and Terra on one difficult bug

Runs: **2026-09-04 20:01–20:10 America/Chicago** (2026-09-05 01:01–01:10 UTC) ·
[VUH-1107](https://linear.app/vuhlp/issue/VUH-1107/compare-astra-and-terra-on-four-complete-clankie-jobs)

The directory is named for the local date, matching every other archive here.

Code: Clankie `a4353d43`. Both arms ran against an isolated second service on
`127.0.0.1:4410`, with its own config, state, cache, Herdr and bearers. The owner's live
service, live model selection, live Herdr fleet and Keychain were never written.

## Verdict

**Both arms completed and both produced a genuine fix.** Each re-derived the same
one-line cause from a symptom-only report and passed the frozen regression test.

This is **one case at one effort with one repetition**. It does not rank the models, and
nothing here should be read as a strength result. Its value is that the harness now runs
end to end and that the differences below are real and measured.

## What was run

A bug already fixed in this repo by `8bbf18ee`: `HostedWorldBody` built its world action
idempotency key as `clankie-action-<counter>`, and the counter restarts at zero when a
replacement body rejoins the same world session. After a reconnect the world matched the
new action against its cached receipt for the old one and returned the previous success
without applying the input — a move that silently did nothing.

The fix's **source hunk only** was reverted in a fresh detached worktree per arm. The
regression test that ships with the fix was left in place. Both worktrees carried a
byte-identical regression, and both were verified red before dispatch.

The regression is archived as [`flows/regression-at-a4353d43.diff`](flows/regression-at-a4353d43.diff)
— a patch against the baseline, not the fix commit's own diff. `body.ts` drifted between
`8bbf18ee` and `a4353d43`, so reversing the commit diff does not apply, and `--3way` merges
it into conflict markers. The commit's diff is kept as
[`flows/regression-source-hunk-from-8bbf18ee.diff`](flows/regression-source-hunk-from-8bbf18ee.diff)
for provenance only; it is not what the flow applies.

The brief was symptom-only — a play-side report of actions that stop taking effect after a
reconnect, and the worktree the agent may touch. It names no file, no mechanism, and no
fix ([`flows/brief-terra.md`](flows/brief-terra.md),
[`flows/brief-astra.md`](flows/brief-astra.md); identical apart from the path).

**The test is agent-visible.** It sits in the worktree, both arms ran it, and both used it
while working. This is a red→green check, not a hidden check.

The red and green baselines are recorded as Vitest JSON, not as exit codes:
[`evidence/baseline-red.json`](evidence/baseline-red.json) is 31 collected, 1 failed, and the
one failure is `does not reuse action keys when the world replays an existing join`;
[`evidence/baseline-green.json`](evidence/baseline-green.json) is 31 collected, 0 failed. An
exit code alone cannot tell those from a suite that collected nothing or failed somewhere
else, both of which would read as a pass.

## Results

|                                    | Terra                                   | Astra                                 |
| ---------------------------------- | --------------------------------------- | ------------------------------------- |
| Selection (CLI, before run)        | `openai-codex/gpt-5.6-terra` @ `medium` | `openai-codex/gpt-6-astra` @ `medium` |
| Effective transport                | `openai-codex-responses`                | `openai-codex-responses`              |
| Reported context / max output      | 272,000 / 128,000                       | 400,000 / 128,000                     |
| Turn wall clock                    | **204.2 s**                             | **215.8 s**                           |
| Outcome                            | `completed`                             | `completed`                           |
| Tool calls (`turn-settled`)        | 32 — bash 27, edit 3, read 2            | 22 — bash 18, edit 3, `herdr_watch` 1 |
| Mutating calls                     | 23                                      | 19                                    |
| Survey calls before first mutation | 1                                       | 0                                     |
| Context tokens end                 | 109,057                                 | 83,419                                |
| Operator interventions             | **0**                                   | **0**                                 |
| Source fix correct                 | yes                                     | yes                                   |
| **Frozen test green**              | **yes**                                 | **yes**                               |
| Frozen test left unmodified        | **no** — rewrote it                     | **yes** — added a second test         |
| Files touched beyond source+test   | none                                    | `docs/architecture.md`                |
| Work still running at settle       | no                                      | yes — a delegated review              |

The two arms ran with **different configured context windows**: 272,000 for Terra, from Pi's
own catalog entry, and 400,000 for Astra, from the catalog fill carrying `SUBSCRIPTION_LIMIT`.
Both numbers are recorded as measured. This is not cosmetic — that metadata is what
compaction and context management read, so the two arms were configured differently and may
have behaved differently because of it. Sharing an endpoint does not make them equivalent,
and nothing here establishes what either model's usable window on this transport actually
is. Treat any cross-arm comparison of context behaviour as confounded until the two are
configured alike.

Tool counts here are from `turn-settled.jsonl`, which counts calls. The durable event stream
carries roughly twice as many tool events because it emits start and end separately.

### Terra

Restored the per-body UUID prefix with a comment explaining why the counter alone replays,
then **rewrote the existing regression test**: it taught the fake world to actually cache
and replay receipts by key, and asserted the post-reconnect action advances position and is
not replayed. It kept the original assertions. The rewrite strengthened the check — but the
frozen test was not preserved, so the green in its own worktree is not a clean signal. The
clean signal is [`evidence/terra-source-only.diff`](evidence/terra-source-only.diff) applied
to a pristine `a4353d43`: 31 passed.

Its report was accurate, including that `pnpm check` was blocked by pre-existing formatting
failures in `apps/docs/site/*.html`. Those two files really are unformatted at `a4353d43`;
this was verified in a clean worktree and is **not** evidence that it left its own.

### Astra

Applied the same one-line fix with an equivalent comment, **added** an 83-line test beside
the frozen one rather than editing it (zero deletions), and recorded the invariant in
`docs/architecture.md`.

It also spawned a `hosted-action-review` Codex agent in its own private Herdr and settled the
turn while that review was still running, saying so plainly: _"Independent review is running
in `w1:p1`; I'll harvest it when finished."_

**Record this as incomplete delegated work.** The delegated agent was still working when the
bounded run ended and was stopped at teardown; its findings never reached the arm, and the
capacity it consumed produced nothing. That makes this arm's completion partial by its own
account. It is not evidence about either model's quality, and it is not a defect on the
evidence available — one run cannot distinguish a habit from an accident of this brief. The
docs edit is defensible under this repo's own instructions.

## Measurement limits

- **Usage and cost are unavailable.** Nothing persists per-turn token usage or cost:
  `runTokens` lives only in memory and ADR 0111 prunes conversation meta. `contextTokensEnd`
  is context occupancy at settle, **not** total usage — it excludes every earlier tool
  round trip and cannot be summed into a bill.
- **Subscription is not free.** Both arms ran on the ChatGPT subscription, where the catalog
  prices tokens at zero. That is an accounting artifact, not an economic one; these runs
  consumed real subscription capacity, and Astra's delegated review consumed more.
- **Model, provider and effort appear in neither telemetry store.** They were captured
  out-of-band from `clankie model status` / `effort status` before each arm, and from a
  read-only resolve through the same code the service uses.
- One case, one repetition, one effort tier. An 11-second wall-clock difference across a
  single run is noise.

## Isolation

Two defects in the harness were found and fixed **before any turn ran**, and both are worth
knowing for cases B–D:

1. **The test captain adopted the owner's live Herdr fleet.** `resolveHerdrBinding` treats
   `runtime: auto` plus an inherited `HERDR_ENV=1` as "attach to the ambient session", so a
   service launched from inside a Herdr pane binds the operator's fleet socket regardless of
   how isolated its config is. Fixed by pinning `clankie herdr set --runtime bundled` and
   scrubbing `HERDR_*` from the launch environment. After the fix each arm ran on its own
   supervised Herdr at `<state>/herdr/herdr.sock` in workspace `w1`, never the owner's `w1K`.
2. **State contaminated by that first boot.** Before the fix the captain had enumerated the
   live fleet and seeded persona conversations named after real panes. The isolated state was
   wiped and rebooted to a single default conversation before arm 1, and again between arms.

Verified after teardown: no `clankie-case-a` process remains, ports 4410/4421 closed, the
owner's service healthy on 4310, and the owner's fleet intact with all four workspaces.

## Reproduction

[`flows/run-arm.sh`](flows/run-arm.sh) runs one arm end to end: worktree, regression, red
baseline, isolated service, dispatch, and the frozen-test check, with teardown on exit.
[`flows/check-flow.sh`](flows/check-flow.sh) exercises its guards, the brief substitution and
the suite assertions locally — no service, no credential, no model call.

```bash
cd docs/testing/2026-09-04-astra-terra-comparison/flows
./check-flow.sh                                              # 28 local checks
./run-arm.sh --arm terra --root ~/.case-a-terra --check      # prerequisites only
./run-arm.sh --arm terra --root ~/.case-a-terra
./run-arm.sh --arm astra --root ~/.case-a-astra
```

`--root` must be a **new absolute directory**, and each arm needs its own: reusing one would
carry the previous arm's config and state forward, and teardown removes only what the run
created. An existing path is refused outright, which also covers `/` and `$HOME`.

What the script does that a hand-run misses:

- **Refuses a `--root` over 60 characters.** Herdr's Unix sockets cap at 103 bytes and the
  runtime appends `/herdr/herdr-client.sock`, so a deep scratch path fails at service boot.
- **Validates `--port` as a whole number in range** before doing arithmetic to derive the
  relay port.
- **Mints both bearers and never echoes them.** Without `CLANKIE_OPERATOR_TOKEN` and
  `CLANKIE_CAPTAIN_TOKEN` the isolated service mints into, and reads from, the owner's
  Keychain.
- **Scrubs every `HERDR_*` variable** by enumerating the environment, and pins Herdr to
  `bundled`. Both are required — see Isolation below.
- **Sends a run-local brief.** The archived briefs name the original run's worktree; the flow
  rewrites that path to this run's and asserts the old one is gone and the new one present
  before dispatch. The archived briefs themselves stay byte-exact.
- **Asserts the red baseline is the known regression alone** — 31 collected, exactly 1 failed,
  and that failure named. A suite that collected nothing, failed to import, or failed a
  different test aborts the run instead of producing a meaningless green.
- **Asserts the frozen check passes over the full suite**, not merely that Vitest exited 0.
- **Runs `clankie model refresh` first**: a fresh isolated cache carries only the bundled
  snapshot, which has no `gpt-6-astra`.
- **Asserts the private Herdr socket** after boot; its absence aborts the run.
- **Checks correctness with the arm's source alone** against the frozen test in a pristine
  `a4353d43` worktree — never the agent's own copy of the test.
- **Tears down only what it started**: the service's own process group (job control, not an
  argv regex that could match a bystander), the agents on its own private Herdr socket, and
  its two worktrees. It preserves the run's exit status and keeps `<root>/logs`.

Everything lands in `<root>/logs`: the selection, the red and green reports as JSON and text,
the run receipt, the brief as sent, the agent's full diff, its source-only diff, the files it
touched, and `turn-settled.jsonl`.

## Evidence

| File                                                                                                                                       | What it holds                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [`evidence/summary.json`](evidence/summary.json)                                                                                           | Both arms' timing, counts and settle phase                                         |
| [`evidence/turn-settled.jsonl.txt`](evidence/turn-settled.jsonl.txt)                                                                       | The service's own `captain.turn.settled` line per arm                              |
| [`evidence/terra-run.json`](evidence/terra-run.json), [`evidence/astra-run.json`](evidence/astra-run.json)                                 | Full durable conversation transcripts                                              |
| [`evidence/terra-agent.diff`](evidence/terra-agent.diff), [`evidence/astra-agent.diff`](evidence/astra-agent.diff)                         | Everything each arm changed                                                        |
| [`evidence/terra-source-only.diff`](evidence/terra-source-only.diff), [`evidence/astra-source-only.diff`](evidence/astra-source-only.diff) | The source fix alone, as checked against the frozen test                           |
| [`evidence/baseline-red.json`](evidence/baseline-red.json), [`evidence/baseline-green.json`](evidence/baseline-green.json)                 | The red and green baselines as Vitest JSON, which is what the flow asserts against |
| [`flows/run-arm.sh`](flows/run-arm.sh), [`flows/check-flow.sh`](flows/check-flow.sh), [`flows/assert-suite.mjs`](flows/assert-suite.mjs)   | The runnable flow, its local check, and the suite judgement                        |
| [`flows/`](flows/)                                                                                                                         | The two briefs as sent, and the regression patch                                   |
