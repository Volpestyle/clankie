# Clankie instruction and skill evals

[ADR 0203](adr/0203-clankie-keeps-what-better-models-cannot-absorb.md) makes measured
results the prerequisite for instruction and skill cuts. The versioned suite is
[`scripts/evals/cases.mjs`](../scripts/evals/cases.mjs): twelve small coding, UI and
research tasks derived from September 2026 commits, plus six synthetic Discord
and voice scenarios. Every case records its source, task, fixture and executable
check. No private Discord messages or live conversation records are inputs.

These are inexpensive reproductions, not full historical issue replays. UI cases
check markup/accessibility and console labels, not rendered screenshots. Social
checks cover response choice, trust boundaries and a few concrete requirements;
they are not a judgment of personality quality. The image case uses a generated
red square. A passing small baseline is infrastructure evidence, not grounds to
remove instructions. Use matched cases and repeated trials before deciding cuts.

## Run from this checkout

Requires Node 24+, installed workspace dependencies, macOS `sandbox-exec`, and a
subscription login in the selected CLI. No service needs to run.

```sh
# Inspect the three-case default without authenticating or consuming quota.
node scripts/evals/run.mjs --dry-run

# Current instructions + bundled skills: up to 3 Claude calls, no rework.
node scripts/evals/run.mjs

# One Codex subscription call (keep the weekly budget small).
node scripts/evals/run.mjs --harness codex --cases memory-card --max-runs 1

# Matched A/B: one case, 2 calls, selected subscription/model.
node scripts/evals/run.mjs --harness claude --cases memory-card --configs current,plain --max-runs 2

# Review cost, pass counts and rework from retained reports.
node scripts/evals/report.mjs /path/to/report.json /path/to/other/report.json

# Larger runs require an explicit call ceiling; preview first.
node scripts/evals/run.mjs --cases all --configs current,plain,trimmed --max-runs 54 --dry-run
```

The installed native Claude 2.1.285 timed out during sandbox startup on the
baseline machine. The tested fallback is the official JavaScript Claude Code
2.1.0 package, selected with `--cli PATH`; it still uses the owner's subscription.
Install it into a temporary directory without changing the installed CLI:

```sh
EVAL_CLAUDE_DIR=$(mktemp -d /private/tmp/clankie-claude-js-XXXXXX)
npm pack @anthropic-ai/claude-code@2.1.0 --pack-destination "$EVAL_CLAUDE_DIR"
tar -xzf "$EVAL_CLAUDE_DIR/anthropic-ai-claude-code-2.1.0.tgz" -C "$EVAL_CLAUDE_DIR"
node scripts/evals/run.mjs --cli "$EVAL_CLAUDE_DIR/package/cli.js" --cases discord-addressed --max-runs 1
```

Pin the CLI and model across A/B arms. This older CLI defaults to Sonnet 4.5;
the fallback results do not characterize the newest Claude model. The
[initial baseline](testing/2026-09-30-clankie-evals/README.md) retains the startup
failure and actual check failures as well as passes.

The runner is also callable as `run(plan(args))` from
[`run.mjs`](../scripts/evals/run.mjs). This is checkout development tooling, with
no live HTTP route or persistent TUI setting. All settings are explicit arguments.
`--model NAME` pins a CLI model; otherwise its default and reported identity are
recorded. Effort is low in Codex and in Claude versions that expose `--effort`. `--timeout` defaults to 120 seconds per
call, and kills the owned process group. Claude additionally gets eight turns.

`--max-runs` (default 3) counts calls across configurations and repair attempts.
`--rework 0|1|2` defaults to zero: no retries, judges, or agent fleets consume hidden
quota. A repair receives the failed check and previous final response in a fresh
worktree. `--token-budget` (default 60000) stops **between** calls using reported
tokens; it is not a hard per-call ceiling or a provider quota estimate. A single
call can overshoot. Timeout and call count are the hard limits. Missing usage is
explicitly unknown, never a zero-cost success. Failures and unrun cells remain
visible, and the command exits nonzero if a selected cell never passes.

## Conditions

[`configurations.json`](../scripts/evals/configurations.json) defines named arms:

| Name      | Instructions                                       | Skills                   |
| --------- | -------------------------------------------------- | ------------------------ |
| `current` | Current `apps/clankie/src/captain/instructions.md` | Bundled                  |
| `plain`   | Same current instructions                          | Product/tool skills only |
| `trimmed` | Versioned experimental `scripts/evals/trimmed.md`  | Bundled                  |

The runner calls the same `bundledSkills` selector as `clankie skills opinionated
on|off` and `hire_agent`'s `skills: bundled|plain`. It does **not** toggle the
owner's settings or launch a live hire. The fixture catalog is copied, not linked;
no personal/global skills or exclusions are inherited. Both CLIs receive identical
instruction text and a catalog of selected skill paths, which they can read on
demand. `trimmed` is an experimental treatment, not a shipped instruction cut.
The report records instruction and selected skill hashes, suite hash, source
revision, fixture Git revision, CLI version/binary hash, runner hash, model (when
reported), and arguments.
The current arm is the versioned Clankie prompt in a headless harness, not the
live service's complete persona, memory, tools or transport prompt.

## Isolation and authentication

Every attempt has an independent fixture Git repository, a detached worktree,
private home/config/cache/temp directories, and a clean allowlisted environment.
Its `.git` points only into its own seed repository. Source checkout files are
copied by the parent; the model cannot read the checkout or the owner's home.
The OS sandbox restricts writes to the attempt, denies signals to other processes,
denies loopback TCP and local service sockets, and permits outbound HTTPS
plus the system DNS socket. HTTPS is not restricted to provider domains. There are no service, Discord, tracker or MCP credentials or hooks.
The checker runs in the same filesystem boundary with network disabled; its
trusted oracle is installed after the model exits. Unsupported platforms fail
closed rather than dropping isolation. Tests exercise outside-file access,
process signaling, loopback denial, fixture writes and check execution.

Codex must have ChatGPT OAuth login; API-key authentication is rejected. Claude
must report `claude.ai` subscription authentication. The parent reads only Claude's
OAuth record (from its credentials file or the CLI's `Claude Code-credentials`
Keychain item) and copies it into the private home; the child has no Keychain
access. Neither harness inherits API keys, provider overrides or user config.
Refresh tokens are stripped so trials cannot rotate shared subscription credentials;
expired access tokens fail until the owner logs in normally. No login or refresh is
written back to the owner's files. Attempt homes, including
OAuth copies, are removed in `finally`; abrupt host/process termination may leave
an attempt directory, so treat the local temporary campaign directory as private.
Do not publish a whole campaign directory.

## Evidence and metrics

Each campaign prints its temporary evidence directory and writes `report.json`.
Per-attempt artifacts include prompts, JSONL CLI events, stderr, executable check
output, and the actual worktree deliverables. Reports include pass/fail, wall time,
provider token buckets, attempts/rework, failed tool calls, exit status, timeout and
budget stops. Rework counts judge-directed fresh attempts; failed tool calls capture
within-attempt tool failures, not every internal model revision. Claude model usage
includes auxiliary model calls when the CLI reports them.
Known credential values are redacted from captured logs.

Headless harnesses do not emit Clankie service turns. Their metrics source is
explicitly `CLI events (no service turn)`. If an isolated attempt does produce a
`home/.clankie/captain/turn-settled.jsonl`, the existing `TurnSettledLog` reader
retains those rows. This reuses the schema behind `clankie metrics`; the runner
never reads the live `~/.clankie/captain/turn-settled.jsonl` or calls live metrics.
Codex cached input is already included in input tokens; Claude's cache buckets
are added separately. No dollars are inferred from a subscription run.

Review and copy sanitized reports/checks/deliverables into the existing
`docs/testing/` archive, then attach the commit/report link with
`clankie work attach VUH-1454 --url URL --caption TEXT --kind log`. Do not attach
credentials, private homes or provider sessions. The baseline archive documents
its sampled scope and failures as well as passes.
