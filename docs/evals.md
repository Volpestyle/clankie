# Clankie instruction and skill evals

[ADR 0203](adr/0203-clankie-keeps-what-better-models-cannot-absorb.md) makes measured
results the prerequisite for instruction and skill cuts. Two suites feed that
decision, and both compare the same arms on the owner's Claude and Codex
subscriptions:

- **Terminal-Bench** ([`benchmark.mjs`](../scripts/evals/benchmark.mjs)), an
  established agent-harness benchmark that nobody here wrote. It answers whether
  the Clankie layer helps or hurts ordinary coding work.
- **The Clankie suite** ([`cases.mjs`](../scripts/evals/cases.mjs)): small coding,
  UI and research fixtures derived from September 2026 commits, a regression case
  for each 2026-09-29/30 incident, synthetic Discord and voice scenarios with
  explicit rubrics, and a private held-out slice.

Every case records its source, task, fixture and executable check. No private
Discord messages or live conversation records are inputs. Results are trials, not
anecdotes: five repetitions per case by default, pass rates with confidence
intervals, and a paired comparison that says when a difference is within noise.

## Conditions

[`configurations.json`](../scripts/evals/configurations.json) defines named arms:

| Name       | Instructions                                                                                 | Skills                   |
| ---------- | -------------------------------------------------------------------------------------------- | ------------------------ |
| `bare`     | None: the harness alone                                                                      | None                     |
| `current`  | Current `apps/clankie/src/captain/instructions.md`                                           | Bundled                  |
| `plain`    | Same current instructions                                                                    | Product/tool skills only |
| `pre-1456` | The instructions before the VUH-1456 cut, frozen in `scripts/evals/instructions-pre-1456.md` | Bundled                  |
| `trimmed`  | Versioned experimental `scripts/evals/trimmed.md`                                            | Bundled                  |

`bare` against `current` measures the whole Clankie layer; `plain` against
`current` isolates the opinionated skills (VUH-1457); `trimmed` against `current`
tests the next instruction cut. `trimmed.md` holds the candidate text; when a cut
lands, the file matches `current` until the next candidate. `pre-1456` keeps
comparisons that started before the VUH-1456 cut on the old prompt
([results](testing/2026-09-30-instruction-trim/README.md)). The skill selection calls the same
`bundledSkills` selector as `clankie skills opinionated on|off` and `hire_agent`'s
`skills: bundled|plain`, and never toggles the owner's settings. The current arm
is the versioned Clankie prompt in a headless harness, not the live service's
persona, memory, tools or transport prompt.

## Terminal-Bench

[Harbor](https://harborframework.com) is Terminal-Bench's official harness. It
builds each task's container, installs the unmodified Claude Code or Codex CLI at
a pinned version, runs the task, and scores it with the task's own tests. The
Clankie layer reaches the CLI the way it would in a seat: Claude receives the
instructions through `--append-system-prompt`, Codex through
`developer_instructions`, and both get the selected skills as native skills.
`bare` passes neither.

Benchmark choice, checked 2026-09-30:

- Terminal-Bench is current. The headline release is
  [4.0](https://snorkel.ai/leaderboard/terminal-bench-4-0/) (August 2026, 66
  tasks), but every 4.0 task has an 8-hour agent timeout and 0.75 to 60 expert
  hours of work. Five repetitions of two arms on those tasks is an API-budget
  experiment, not a subscription one. The runner supports 4.0 for single-rep checks.
- [Terminal-Bench 2.1](https://www.tbench.ai/news/terminal-bench-2-1) (May 2026,
  89 tasks) is the maintained revision of 2.0, still scored by
  [Artificial Analysis](https://artificialanalysis.ai/evaluations/terminalbench-2-1).
  Most tasks have 15-minute timeouts and prebuilt images, so it is the default
  A/B dataset.
- SWE-bench Verified is not used: OpenAI
  [stopped reporting it](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)
  in February 2026 after finding frontier models could reproduce gold patches.

[`benchmark-tasks.json`](../scripts/evals/benchmark-tasks.json) pins the task sets.
The `ab` set is five hard 2.1 tasks from different categories with 900-second
timeouts and at most 1 CPU / 2 GB. It was fixed before any Clankie trial ran.
The images are amd64; on Apple Silicon they run under Docker's emulation, which
adds roughly 3.5 minutes of setup per trial and slows compute-heavy tasks for
both arms alike. Leaderboard numbers are not comparable to these.

Requires Docker and Harbor (`uv tool install harbor`, or a virtual environment
passed with `--harbor PATH`):

```sh
# Preview the default A/B: 5 tasks × bare,current × 5 reps = 50 trials.
node scripts/evals/benchmark.mjs --model claude-sonnet-5-5 --max-trials 50 --dry-run

# Run it: three containers at a time, stopping at the usage guard.
node scripts/evals/benchmark.mjs --harness claude --model claude-sonnet-5-5 \
  --configs bare,current --max-trials 50 --concurrency 3

# A single Terminal-Bench 4.0 check of one task and arm.
node scripts/evals/benchmark.mjs --dataset terminal-bench/terminal-bench@4.0.0 \
  --tasks music-harmony --configs current --reps 1 --max-trials 1
```

A campaign can outlive a terminal session; start long ones with `nohup`. Each
trial's Harbor directory keeps the agent log, trajectory, verifier output and
`result.json`. Reported tokens come from Harbor, whose input count already
includes cached input.

## The Clankie suite

`--cases` takes case IDs or these sets, comma-separated:

| Set         | Cases                                                             |
| ----------- | ----------------------------------------------------------------- |
| `smoke`     | `memory-card`, `evidence-research`, `discord-addressed` (default) |
| `incidents` | One regression per 2026-09-29/30 incident (below)                 |
| `social`    | The Discord and voice scenarios                                   |
| `code`      | Every public non-social case                                      |
| `all`       | Every public case                                                 |
| `heldout`   | The private held-out slice, when mounted                          |

### Incident regressions

Each reproduces a failure from ADR 0203's list. The four code cases start from
the buggy behaviour and their checks mirror the assertions of the fix that closed
the incident, so the correct outcome is known rather than invented.

| Case                          | Incident                                                             | Fix                 |
| ----------------------------- | -------------------------------------------------------------------- | ------------------- |
| `incident-unaddressed-image`  | Replied to nearly every unaddressed image                            | 16914469 (VUH-1453) |
| `incident-brief-receipt`      | `hire_agent` brief arrived truncated                                 | 90cf84a1 (VUH-1450) |
| `incident-reconnect-followup` | Unaddressed follow-up missed after a gateway reconnect               | 3234c90a (VUH-1447) |
| `incident-swarm-offline`      | One Swarm disconnect failed every seat tool                          | c2c2f401            |
| `incident-signin-lockout`     | Lost token rotation signed the Mac out; hosted check blocked sign-in | 204277ce, 19b1f4ae  |

### Social rubrics

Every social case carries a `rubric`: the criteria a good answer meets. Criteria
marked `scored` are exactly what the executable check enforces; the rest are for
the person reading the retained `answer.json`. No model judges an answer, so no
hidden quota is spent and the score cannot drift with a judge's mood. Voice cases
are text reproductions of the decision, not audio.

### Held-out slice

The held-out cases live in the private `clankie-evals-holdout` repository under
`clankie/cases.mjs`, mounted at the ignored `evals/holdout` path, and vary the same
incidents. Instruction and skill work (VUH-1456, VUH-1457) must not read them or
tune against their per-case results; reports record the slice's hash and show it
only as an aggregate. Change a held-out check only in review independent of the
change it judges.

```sh
# Inspect the default without authenticating or consuming quota.
node scripts/evals/run.mjs --dry-run

# Incident and social A/B with the held-out slice: 16 cases × 2 arms × 5 reps.
node scripts/evals/run.mjs --harness claude --model claude-sonnet-5-5 \
  --cases incidents,social,heldout --configs bare,current --max-runs 160 \
  --token-budget 12000000 --timeout 180 --pause 2

# One Codex subscription call.
node scripts/evals/run.mjs --harness codex --cases memory-card --reps 1 --max-runs 1
```

`--max-runs` (default 15) counts calls across arms, repetitions and repair attempts;
a larger matrix must raise it explicitly. `--rework 0|1|2` defaults to zero: no
retries, judges, or agent fleets consume hidden quota. A repair receives the failed
check and previous final response in a fresh worktree. `--token-budget` (default
2,000,000) stops **between** calls using reported tokens; a single call can
overshoot. `--timeout` (default 120 seconds per call) kills the owned process group,
and Claude additionally gets eight turns. Effort is low in Codex and in Claude
versions that expose `--effort`. Pin `--model` across arms.

## Statistics

`node scripts/evals/report.mjs [--markdown] REPORT.json ...` groups trials by
harness, CLI version, model and suite. A trial is one repetition of one case in
one arm; it passes when any of its attempts passed, and failed attempts still
count toward its cost.

- **Pass rate** carries a 95% Wilson interval over trials.
- **Tokens and wall time per trial** carry 95% bootstrap intervals. Unknown usage
  is excluded from the mean and counted separately, never treated as zero.
- **Comparisons** subtract the reference arm (`bare` when present) on the cases
  both arms ran. Repetitions of one case are correlated, so the bootstrap
  resamples cases, then trials within each case. A difference whose interval
  includes zero is reported as **within noise**; with fewer than three trials an
  arm, it is reported as too few trials. Comparisons are also broken down by
  slice (benchmark, incident, social, held-out, other code).

With five repetitions of a dozen cases, only large effects are distinguishable.
Treat a within-noise result as "not shown", never as "no effect".

## Subscription terms and limits

Checked 2026-09-30. Evals run on the owner's subscriptions, as ADR 0203 decides,
so they must stay inside those terms:

- **Claude.** The [Consumer Terms](https://www.anthropic.com/legal/consumer-terms)
  forbid automated access "except … via an Anthropic API Key or where we
  otherwise explicitly permit it". Claude Code's
  [legal page](https://code.claude.com/docs/en/legal-and-compliance) permits an end
  user signing in to the unmodified Claude Code binary with their own
  subscription, including where a platform hosts it. Anthropic's
  [support article](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
  (June 2026) says `claude -p` still draws from subscription limits. Both runners
  use only the unmodified CLI with the owner's own credential, and nothing else
  calls the API with it. The same page says advertised limits assume "ordinary,
  individual usage": a sweep of hundreds of long trials is not ordinary use and
  belongs on an API key.
- **Codex.** ChatGPT plans include [`codex exec` and scriptable workflows](https://learn.chatgpt.com/docs/pricing);
  OpenAI recommends an API key for automation in shared environments like CI.
  Plans have five-hour and weekly windows.
- **Throttle.** Both CLIs report live window usage: Claude Code's stream-json emits
  `rate_limit_event` with five-hour and seven-day utilization, and Codex writes
  `rate_limits` into its session rollout. After every call, both runners compare
  it with `--stop-at` (default `five_hour=0.8,seven_day=0.5`). A five-hour window
  past its threshold waits for that window's reset. The weekly window or an actual
  rate limit stops the run, leaving the rest of the week to the owner's other
  agents. On 2026-09-30 Codex's weekly window was already at 86%, so the baseline
  ran on Claude. The benchmark runs at most three containers at once.

## Isolation and authentication

Every Clankie-suite attempt has an independent fixture Git repository, a detached
worktree, private home/config/cache/temp directories, and a clean allowlisted
environment. Its `.git` points only into its own seed repository. Source checkout
files are copied by the parent; the model cannot read the checkout or the owner's
home. The macOS sandbox restricts writes to the attempt, denies signals to other
processes, denies loopback TCP and local service sockets, and permits outbound
HTTPS plus the system DNS socket. HTTPS is not restricted to provider domains.
Reads are limited to system runtimes, the attempt, the CLI's own directory, and
the timezone database (Claude Code after 2.1.0 hangs at startup without it).
There are no service, Discord, tracker or MCP credentials or hooks. The checker
runs in the same boundary with network disabled; its trusted oracle is installed
after the model exits. Unsupported platforms fail closed.

Terminal-Bench trials run in Harbor's Docker containers. The campaign has a
private `HOME`; the credential is passed in the trial's environment (Claude) or a
0600 file removed after the trial (Codex), and never appears in Harbor's saved
configuration.

Codex must have ChatGPT OAuth login; API-key authentication is rejected. Claude
must report `claude.ai` subscription authentication. The parent reads Claude's
OAuth record from its credentials file and the CLI's `Claude Code-credentials`
Keychain item and uses the freshest one valid for at least 30 minutes; a leftover
file token without an expiry once shadowed the live Keychain token and failed with 401. The child has no Keychain access. Neither harness inherits API keys, provider
overrides or user config. Refresh tokens are stripped so trials cannot rotate
shared credentials; the benchmark re-reads the access token for every trial,
because the owner's own sessions keep refreshing it. Attempt homes and credential
files are removed in `finally`. Abrupt termination may leave an attempt directory,
so treat the local campaign directory as private and never publish a whole one.

## Evidence

Each campaign prints its temporary evidence directory and writes `report.json`.
Clankie-suite attempts keep prompts, JSONL CLI events, stderr, check output and the
worktree deliverables; benchmark trials keep Harbor's trial directory. Reports
record instruction and skill hashes, suite and held-out hashes, source revision,
CLI and Harbor versions, runner hash, model, subscription window usage per call,
and arguments. Headless harnesses emit no Clankie service turns, so metrics come
from CLI events; an isolated `turn-settled.jsonl` is read if one appears.

Copy sanitized reports and summaries into `docs/testing/`, then attach the link
with `clankie work attach ISSUE --url URL --caption TEXT --kind log`. Never attach
credentials, private homes, provider sessions or held-out case content.

Baselines: [VUH-1454](testing/2026-09-30-clankie-evals/README.md) (single trials,
current arm only) and [VUH-1467](testing/2026-09-30-eval-baseline/README.md)
(repeated bare against current on both suites).

### Codex account selection

`node scripts/evals/codex.mjs --account LABEL ...` pins one registered
Codex account for the entire campaign. Without `--account`, it uses the same
headroom selector as local hires (`clankie accounts codex list`). The report
records the label and home. The usage guard starts with that home's known
windows and then reads the isolated trial rollouts; it never switches accounts
to continue after a guard stop. An initial guard stop or wait refuses the campaign
before credentials are loaded; start again after the reset. All regular
`run.mjs` arguments apply, except the harness is fixed to Codex.
Big sweeps belong on an API key with an explicit
spend budget, not rotated subscription accounts.
