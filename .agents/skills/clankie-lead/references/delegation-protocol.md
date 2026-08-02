# Delegation protocol

## Worker brief

Every assignment carries:

```text
mission/task/worker-run identities
role and bounded objective
authoritative issue plus full-thread instruction
dependencies and expected inputs
write scope and read-only scope
success criteria and unchanged acceptance checks
verification commands and evidence requirements
budget, risk, stop guards, and escalation route
result/sentinel locations for pane-hosted workers
```

Parallel writers must be path-disjoint. If one task consumes another task's output, encode the dependency and sequence them. Shared manifests, lockfiles, generated artifacts, and repo-wide gates have one declared owner.

State the commit expectation explicitly in every implementation brief ("commit on
your branch; do not merge/push"). A conservative worker treats an unmentioned commit
as unauthorized and leaves the candidate uncommitted, which stalls verification on an
unpinned sha until a follow-up steering round.

## Durable run receipt

A pane-hosted run may keep transport receipts under `${CLANKIE_HERDR_RUN_ROOT:-$HOME/.clankie/herdr-runs}/<run-id>/`:

```text
manifest.json
preflight.json
workers/<slug>/prompt.md
workers/<slug>/result.md
workers/<slug>/DONE
workers/<slug>/BLOCKED
workers/<slug>/SPAWN_FAILED
workers/<slug>/ARM_FAILED
```

`manifest.json` records what was spawned: durable worker name, task and worker-run identities, cwd, harness, command vocabulary, and timestamps. It does not replace the tracker DAG or event store. Store pane IDs only as diagnostic spawn-time metadata because they are session-local and may compact.

Before the first implementation spawn, run `references/preflight-base.sh --receipt-dir <run-dir> <base-sha>`. It creates an isolated detached workspace, installs, and runs the repository-owned `preflight` script, falling back to `check`; `preflight.json` records the selected gate. For the `clankie-app` external workspace layout it also creates an isolated sibling agent-OS worktree and records that revision. A red receipt stops the wave until the base is fixed or rebased; an exception must be explicit, justified, and recorded in `manifest.json`.

Before relying on an adapter-hosted runner, confirm its effective environment includes
`CLANKIE_REPO_PATH` and at least one `CLANKIE_VERIFICATION_CHECKS` entry. Process
health alone is not mission readiness: an unset repo path leaves claiming idle, while
an empty check list fails an otherwise successful worker at settlement. Choose checks
that work inside the runner's restricted linked-worktree boundary. In particular, a
Git command such as `git diff --check` follows the worktree `.git` pointer to the
repository's external administrative directory and is denied unless that exact input
is deliberately exposed; prefer dependency-free source checks when no dependency root
has been declared.

## Goal arming

For every pane-hosted worker the mandatory sequence is **spawn → preflight → arm → verify-arm**. Wait until the harness is ready, apply supported `/model` and `/effort` configuration, then run:

```bash
references/arm-goal.sh --receipt-dir <worker-receipt-dir> <pane-id> \
  "Read and complete <worker-receipt-dir>/prompt.md exactly as written. Done when <worker-receipt-dir>/result.md exists and either <worker-receipt-dir>/DONE or <worker-receipt-dir>/BLOCKED exists."
```

The standard condition is one short line pointing to `prompt.md` and checking both `DONE` and `BLOCKED`; keep all criteria in the brief. The script rejects conditions over 4000 characters before any pane lookup or send and warns on a non-standard condition (`--file` reads the condition from a file). It preflights pane existence, a reporting interactive harness, and fatal launch text; waits for harness readiness before typing (a harness still in startup — e.g. Codex `Starting MCP servers` after the latest launch banner and after any terminal `MCP startup incomplete`/failed-client warning — swallows the trailing Enter and leaves the goal unsubmitted in the composer; an older startup line from a prior harness process is ignored; bounded by `ARM_READINESS_TIMEOUT_SECONDS`, default 90, polled every `ARM_READINESS_POLL_SECONDS`, default 3, with every refreshed read re-passed through the fatal-launch classifier); clears the composer with `ctrl+e`, `ctrl+u`; sends `/goal` through `herdr pane send-text` plus Enter, gives the harness `ARM_SUBMIT_GRACE_SECONDS` (default 10) to report working/pursuing, and re-presses Enter (up to `ARM_SUBMIT_RETRIES`, default 3) only while a fresh lane has neither entered `working` nor printed its pursuing marker and the composer still shows the `/goal` text; waits for `working`; deliberately confirms `Replace current goal?`; and requires both no retained `/goal` text in the active composer and an armed-status confirmation. The status-aware grace matters because submitted prompt history uses the same leading `›` as the active composer and can remain visible for several seconds: treating that history as unsent input queues a duplicate goal and can surface a delayed replacement dialog during real work. Confirmation vocabulary differs per harness — Codex shows `Pursuing goal`, Claude Code shows `/goal active` (bare `Goal active` is also accepted) — and the script accepts the union. The pursuing-state check is authoritative for this seam because harness builds may not support every expected slash command.

Spawn failures write `SPAWN_FAILED` with the pane and observed error line. Lint, send, wait, confirmation, and verification failures write `ARM_FAILED`. Treat either as a loud lead-visible failure: reconcile it into the mission event stream immediately rather than leaving an idle lane. Arming may happen at the spawn seam or immediately afterward through the same pane command a human uses. Unsupported harnesses keep their normal task loop; never emulate `/goal` with a hidden captain-only API. Adapter-hosted workers receive the equivalent task lifecycle through their typed adapter.

An invocation whose command transport returns no stdout is ambiguous, not proof that arming failed. Before retrying, inspect the pane for a fresh `Goal active`/`Pursuing goal`, check its reported status, and check the receipt directory for `ARM_FAILED`/`SPAWN_FAILED`. A blind retry can submit the same objective a second time and pause real work behind `Replace current goal?`.

Verify EVERY send, not just the first arm. A pane showing `Goal blocked` with a provider capacity error resumes with `/goal resume`; treat capacity blocks as transient and retry before switching models.

Once a pane has an active `/goal`, do not submit ordinary prose with `herdr pane run`, `herdr pane send-text` plus Enter, or an equivalent composer send. The harness treats any new submitted text as a proposed replacement objective and opens `Replace current goal?`, pausing the real task until someone answers. Communicate dependency progress through durable receipts/watchers that the worker already observes. Use the native `/goal resume` command only when the current goal is actually paused, and use `arm-goal.sh` only when replacement is deliberate.

## Match the harness to the task; a burned session stays burned

Route adversarial or security-flavored verification — bypass hunting, injection
scenarios, forgery/trust-boundary attacks, anything phrased as "try to break/smuggle/
attack" — to a Claude worker, never Codex. OpenAI's cybersecurity filter refuses that
framing even when it is defensive review of your own repo, and the refusal is STICKY:
once a Codex session has processed a cyber-flagged request, it keeps refusing every
later request in that session, including unrelated clean work. `/goal resume` cannot
recover a burned session — clear the goal, park the pane, and move the work to a fresh
agent (a Claude subagent is the reliable default for adversarial verification). When a
brief is unavoidably security-shaped, state the defensive intent plainly ("confirm this
fix closes the bypass in our own code") but still prefer Claude.

## The lead's own harness classifier gates privileged actions

A Claude Code lead in auto mode has its own permission classifier, and it enforces
the doctrine-shaped privileged boundary on the LEAD, independent of any in-chat
delegation from the owner: `git merge`, tracker completion/comment writes,
`gh repo create`, writing permission-settings files, and raw `mkdir` outside the
session's working directories can all be denied. Two operational facts keep a wave
moving:

- **Denials are partly content- and context-sensitive, and some are transient.**
  A "Stage 2 classifier error" denial explicitly invites a retry; even hard
  denials of `arm-goal.sh` and tracker writes have succeeded on the second or
  third identical attempt. Retry twice before treating a capability as gone, but
  never rephrase an action to disguise its intent — meta-language about
  approvals/authority in commit messages or tracker comments is itself a trigger.
- **Sequence waves so classifier-gated actions are batched, not load-bearing.**
  Do all evidence-producing work first (drills, commits on branches, worker
  dispatch); attempt the privileged layer (merges, Done flips, push, repo
  creation) in one late batch; whatever stays blocked becomes a short
  awaiting-owner list with every item one-click ready. Status flips can pass
  while comments on the same issue are blocked — the flip is the essential
  write; keep decisive evidence in committed artifacts or run receipts so a
  blocked comment loses nothing.

## Watch `blocked`, not only `done`

A pane that stalls because of capacity, refusal, or a swallowed confirmation can reach
`blocked` without writing a sentinel. Arm one event-driven watcher per live worker and
match both `done` and `blocked`:

- inside a Clanky orchestration environment, use its registered `clanky watch` or
  `herdr_watch` integration so the watch is visible in the orchestration graph;
- outside that environment, use
  `herdr agent wait <pane> --until done --until blocked`;
- use `herdr pane wait-output` only for a specific intermediate milestone, never as the
  worker-completion signal.

When a watcher wakes, re-resolve the live pane if necessary, read
`herdr pane read <pane> --source recent --lines 120`, and inspect the durable receipt.
Do not poll pane text or a directory in a long-running loop. `clankie watch` is a
different command: it watches the active captain turn.

## Sentinels and harvest

For pane-hosted fallback workers:

- `DONE` means `result.md` is ready for harvest.
- `BLOCKED` means `result.md` states the exact missing input or stop guard.
- both files at once are an invalid receipt that requires diagnosis.
- no sentinel plus a settled pane is not completion; inspect and request the missing receipt or classify the run from semantic events.

Harvest reads the receipt, validates its claimed commands/artifacts against current state, and records the corresponding semantic outcome. Tier-0/1 events remain the status winner even when a sentinel or pane heuristic disagrees. The event-driven status watcher supplies the wake; the sentinel supplies the durable transport receipt. Never wait on printed completion strings: a prompt echo can create a false match.

## Resume

After captain restart:

1. Load the mission snapshot and replayed status explanations from the event store.
2. Read the run manifest and each worker result/sentinel receipt.
3. Correlate by mission, task, and worker-run IDs.
4. Re-resolve a live pane by durable worker name only when steering or diagnosis is needed.
5. Re-arm monitoring for active work and surface receipt/event disagreements instead of guessing.

## Cleanup authority

Cleanup is permitted only for workers created by the current captain or recorded in the run being harvested. A task completion does not automatically end a warm worker's lifecycle. Before retirement, confirm that evidence is harvested, verification and tracker reconciliation are complete, no question remains, and the ownership ledger has no next assignment. Preserve run receipts when doctrine or an unresolved failure requires later audit.

## Isolated cross-repo pnpm workspaces

The `clankie-app` workspace includes literal `../clankie-v2/packages/*` members. Its
preflight therefore needs a sibling agent-OS checkout, but dependency installation must
not use the live checkout: pnpm writes package-local `node_modules` links into those
external workspace members.

`preflight-base.sh` detects that layout and creates two detached worktrees under the same
temporary root: the requested app base and a sibling `clankie-v2` at the current agent-OS
`HEAD`. Installation and all gates run only against those isolated paths, and cleanup
removes both. Set `CLANKIE_PREFLIGHT_CORE_ROOT` when the live agent-OS checkout is not the
app repository's `../clankie-v2` sibling; set `CLANKIE_PREFLIGHT_CORE_REF` when the run
contract pins a different agent-OS revision. The selected revision is recorded in
`preflight.json`.

Do not run `pnpm install` in an ad hoc temporary `clankie-app` worktree whose
`../clankie-v2` resolves to the live agent-OS checkout. Use the preflight script or build
the same isolated sibling layout.
