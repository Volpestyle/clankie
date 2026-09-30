# Herdr lead operations

Read the sections needed for the operation; the lead workflow stays in
[SKILL.md](../SKILL.md). Dispatch authority and ownership rules apply here too.

## Census

Use `herdr api snapshot` for the whole session, including focus and layout,
or `herdr agent list` for agents only. Read only the relevant lanes when
ownership is already clear. The vendored dashboard and its helpers are no
longer bundled; these operations use the Herdr CLI directly.

## Triage before reading panes

`terminal_title_stripped` is the agent's own summary of its current task, and it
is free — it arrives with the census. Combined with `agent_status` and `cwd` it
is usually enough to route without reading a single pane. Reading N panes at 100
lines each is what actually blows your context; spend those reads deliberately.

Sort every agent pane into five buckets:

| Bucket | Meaning | Lead action |
|---|---|---|
| `blocked` | waiting on a human | **Surface to the user first.** This is the real bottleneck; no new dispatch fixes it. |
| `done` | finished, and nobody has looked | Harvest queue — highest value. Read, summarize, decide follow-up. |
| `working` | in flight | Do not interrupt. Record what it owns so you do not dispatch overlapping work. |
| `idle` + trailing question | **asked the user something and is waiting** | Surface it. Never dispatch here — you would clobber a pending decision. |
| `idle`, nothing pending | free capacity with warm context | Best dispatch target when its cwd/topic matches the new work. |
| shell pane | free capacity, no context | Where a fresh agent goes. |

`done` specifically means finished *and unread* — it is a queue of unharvested
results. Harvest work needed by the current request or affecting ownership
first; unrelated finished work must not delay the requested artifact.

**`idle` is the bucket that lies.** herdr's `blocked` means the TUI is showing a
permission prompt. An agent that asked a *conversational* question — "which do
you want?", "want me to file the ticket?" — finished its turn and reports plain
`idle`, indistinguishable in every metadata field from genuinely free capacity.
In practice this is common: expect a real fraction of idle agents to be awaiting
a decision. Always check before treating idle as available.

`agent prompt` refuses a pane sitting at an approval or question dialog
(`agent_blocked`) before sending any input, so the tool protects you from
prompting a `blocked` pane — it cannot protect you from prompting a
conversationally-idle one, which is exactly the case above.

It lies in the other direction too. A pane that asked a question, *got answered*,
and did the work reports the same plain `idle` — and its recap can still be the
one from before the answer. Read that as a live request and you will hand an
agent work it finished several turns ago. `idle` tells you a turn ended, never
which turn.

**Check for unsubmitted input too.** Text typed into an agent's box but never
sent leaves the pane `idle` with a pending prompt one keystroke from running.
No metadata field exposes it; inspect the visible composer directly.

Claude Code's dim suggested follow-up can trip that flag too. Inspect the
pane's ANSI styling when the distinction matters: an automatically suggested
prompt is not text the operator entered and is not authorization to run it.

Before every send, inspect the full visible composer, including wrapped lines:

```bash
herdr agent read <pane> --source visible --format ansi
```

Do not grep only the prompt marker or read only the status line: a partial draft
can span several lines. ANSI styling distinguishes a dim suggestion from entered
text; a suggestion is not authorization. If input is entered, a question is
pending, or a history view/menu hides the composer, hold your message. Wait for
the operator's exchange to finish and the normal composer to be visibly empty;
never press Escape, clear, submit or replace their input to make room. If you
cannot establish that it is clear, keep waiting rather than guessing.

Use the completion wait below when the agent is working, then re-read the
composer immediately before sending. An idle status, a completed wait or an
elapsed delay is not proof that the operator has finished typing. This check
reduces collisions; it is not an atomic reservation against the next keystroke.

## Enrich and read

Deep-read only the shortlist that survives:

```bash
herdr agent read <pane> --source recent-unwrapped --lines 80
```

Use `recent-unwrapped` for reasoning over content — it rejoins soft wraps, so
paths and commands are not split by pane width. `recent` is what the pane
actually renders, `visible` is just the viewport, `detection` is what the status
classifier sees. Start at 60–80 lines and go back further only if the tail is
inconclusive.

**`recent`/`recent-unwrapped` can fail outright on a busy alternate-screen
agent** — `"alternate-screen history can only be captured by scrolling while
idle"`. That is a read failure, not an idle agent and not a broken pane: retry
when it settles, or fall back to `--source visible` and accept the viewport.

## Dispatch and waits

**To an existing idle agent** — `agent prompt` submits through the agent's input
properly; `pane run` types raw text at a TUI and mangles it:

```bash
herdr agent prompt <pane> 'your task here'
```

**Do not add `--wait` when dispatching more than one pane.** It blocks your turn
until that agent finishes, so a fan-out of four becomes four sequential waits and
the last worker starts an hour late. `--wait` is only for a single pane when you
have nothing else to do until it answers. Otherwise — one pane or a wave —
dispatch, arm a background watcher (below), and keep working; the harness wakes you.

Default to prompting an `idle`/`done` pane after checking its visible input.
For a working pane, use a next-turn message only when the current harness
explicitly supports queuing it. Codex can display a message queued for its next
tool boundary; that is delivery to a queue, not acknowledgment or completion.
Read the input first, never append over an operator draft, and reserve queued
messages for an actionable correction or handoff. Do not interrupt productive
work to send routine status. If queuing is not established, wait:

```bash
herdr agent wait <pane> --timeout 300000
```

**Omit `--until`.** Bare, it matches `idle`, `done`, *or* `blocked`. `--until`
matches exact states only, so `--until idle` sits through the whole timeout
while an agent that finished in a background tab (`done`) or stopped at a
permission prompt (`blocked`) waits on you.

Two more `--wait` hazards, both from `agent prompt --help`: waiting from a
non-working state needs an observed state change within 5000ms or it returns
`agent_prompt_stalled`, and **the wait does not track turns** — if the agent was
already working, that pre-existing turn's completion satisfies your wait.

**A fresh agent** — create its own named tab without taking focus;
`agent start` waits for real interactive readiness:

```bash
NEW=$(herdr tab create --workspace "$HERDR_WORKSPACE_ID" \
  --label "Worker topic" --cwd "$PWD" --no-focus \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["root_pane"]["pane_id"])')
herdr agent start worker --kind claude --pane "$NEW" -- --model sonnet --permission-mode auto
herdr agent prompt "$NEW" 'your task here'
```

`--kind` accepts claude, codex, gemini, cursor, opencode, copilot, amp, droid,
and others; the pane must be sitting at a shell prompt.

## Watch dispatched work

The designated harvest owner arms one completion watcher for a new assignment.
Reuse its existing watcher; a status report or another supervisor does not need
another one. Let completion events drive the harvest:

```bash
# Backgrounded, one per pane. The harness re-invokes you when it exits.
herdr agent wait <pane> --until working --timeout 30000 >/dev/null 2>&1
herdr agent wait <pane> --timeout 1800000
```

Both lines matter. The second is the real watcher; the first exists because
`agent prompt` returns before the agent transitions, so a watcher armed
immediately after prompting often matches the pane's *pre-dispatch* idle state
and fires instantly. Wait for `working`, then wait for it to leave.

This is event-driven and costs nothing while it waits. Do not poll pane text on
a timer, and do not schedule wakeups to check on work the harness will notify
you about — the notification is the mechanism.

**Pane completion can precede job completion.** Codex and Grok can report
`idle`/`done` with a background terminal or queued native job still running.
On wake, inspect that specific terminal or producer handle before harvesting.
If it is live, have the owner continue through its existing handle, then watch
the continued turn; never relaunch the job because the pane settled. Grok's
final answer can also scroll below its fold, where `agent read` cannot reach
it — when needed, ask it to write `~/.herdr-handoffs/<lane>-evidence.md` and
reply with the path.

## Organize the session (after approval)

Naming and moving panes mutates the user's terminal. Use existing authorization
when it covers the reorganization; otherwise present the plan first. All of it is safe to run
against `idle` panes; a `working` agent survives a move but gets a redraw.

```bash
herdr pane rename <pane> '<label>'      # --clear to remove
herdr tab rename <tab> '<label>'
herdr workspace rename <ws> '<label>'
herdr pane move <pane> --workspace <ws> --new-tab
herdr pane move <pane> --new-tab | --new-workspace | --tab <tab>
herdr pane move <pane> --split right --target-pane <pane> --ratio 0.5
herdr pane swap <a> <b>
```

What the API does not tell you until you have done it:

- **A pane `label` is a separate field from `terminal_title`.** Naming a pane
  does not shadow the agent's live self-reported title — the census carries
  both. So naming panes costs nothing and is worth doing.
- **A cross-workspace move changes the pane id** (`w7:p4W` → `w8:p1Z`). Take the
  new id from the move response; every id you cached is now wrong.
- A tab move can end an existing `agent wait` with `agent_not_running` even
  when the same agent continues in the same pane. Confirm its session with
  `agent get`, then re-arm the completion watcher; do not restart the worker.
- **The move auto-closes the emptied source tab** and creates the target tab
  labelled with a bare number. Rename it in the same breath or you accumulate
  tabs called `2`.
- **Moving the last pane out of a workspace closes that workspace.** To
  repurpose one, move panes *in* before you move the last one out.
- **Tab order cannot be set from the CLI.** There is no `tab move`; new tabs
  always append. Sequenced `pane move --new-tab` is the only CLI ordering lever,
  and it rebuilds every tab it touches. herdr 0.8.2 added
  `keys.move_tab_previous` / `keys.move_tab_next` to reorder the active tab in
  place — a keybinding for the user, not something you can drive.

Group by *kind of work*, not by history: a builder and its reviewer belong in
one tab, unrelated reviews belong in their own workspace. Name a tab after what
it is (`!764 short code UI`, `aurora migration`), never a default number.

## Gotchas

- **Finished is not necessarily delivered.** Check the requested destination.
  For code, verify the scoped commit and landing policy, including work already
  merged. For artifacts, inspect the file. Ahead counts alone establish neither
  completion nor missing work.

- **A shared file carrying your hunks plus an absent agent's still commits
  cleanly.** When one file mixes your edits with orphaned uncommitted work
  (the owning pane is gone), neither committing the mixture nor skipping your
  fix is right — stage only your hunks: `git diff -- <file>` to a patch, keep
  the hunks containing your identifiers, `git apply --cached <filtered>`.
  Check the orphan hunks survive unstaged afterward, and name the orphan work
  in your report instead of silently leaving it.

- **Pane ids are opaque strings** — `w3:p2J`, `w3:t17`, `w3`. Never construct,
  guess, or increment an id; always take it from a census or from a
  create/split response.
- **Ids compact when panes close, and the user keeps working while you plan.**
  Re-read them; do not cache across a long pass. A batch that renames eight
  panes will hit `pane_not_found` on any the user closed since the census —
  which is normal, not a failure to investigate.
- **`HERDR_PANE_ID` is you** when you are in a pane. A socket-attached lead's
  shell often has it unset even when its face is a pane — if the turn named a
  pane, that pane is you. If no pane was named, take the focused pane from the census.
  Never `agent prompt` yourself. `pane current` / `pane get` /
  `pane layout --current` resolve the *calling* pane, not another client's
  focus, so use them to corroborate a pane identity.
- **A Codex worker's own question blocks it, and `agent prompt` cannot answer.**
  Its pane shows `Queued follow-up inputs · 1 question · ⌥+↑ to answer`, status
  is `blocked`, and every prompt is refused with `agent_blocked`. Answer in its
  dialog: `herdr agent send-keys <pane> alt+up`, read to confirm the question,
  `herdr pane send-text <pane> "<answer>"` (it shows as `[Pasted Content N
  chars]`), then `herdr agent send-keys <pane> enter`.
  A multiple-choice question opens with its first option selected: move with
  `Down`, then `enter`; choosing "Other" opens the same text box. Read the pane
  afterwards to confirm that the dialog closed.
- **Status rolls up.** Tabs and workspaces carry their own `agent_status`, so
  you can skip an entire idle workspace without descending into its panes.
- **`unknown` status on a shell pane is normal** — it means no agent was
  detected there, not that something is wrong.
- Status detection reads the terminal, so a pane the user has scrolled up in can
  still report correctly; use `herdr agent explain <pane> --json` when a status
  looks wrong.
- **`set -e` does not protect a herdr batch script.** A failed `pane rename`
  prints its error JSON and the script runs straight on, even though the same
  command exits 1 on its own. Batch renames are fine — just read the output
  rather than trusting the exit status.

## Command reference

| Need | Command |
|---|---|
| Whole session, raw | `herdr api snapshot` |
| Agents only | `herdr agent list` |
| One agent | `herdr agent get <pane>` |
| Read output | `herdr agent read <pane> --source recent-unwrapped --lines 80` |
| Wait for free | `herdr agent wait <pane> --timeout <ms>` (no `--until`) |
| Send work | `herdr agent prompt <pane> '<text>'` |
| Watch a dispatched pane | background: `herdr agent wait <pane> --until working --timeout 30000; herdr agent wait <pane> --timeout 1800000` |
| Did the lane commit? | `git -C <worktree> status --short && git -C <worktree> rev-list --count main..HEAD` |
| New pane | `herdr pane split <pane> --direction right --no-focus` |
| Launch agent | `herdr agent start <name> --kind claude --pane <pane>` |
| Why this status | `herdr agent explain <pane> --json` |
| Which pane am I | `herdr pane current` |
| CLI skill for *this* binary | `herdr --skill` |
| Name a pane / tab / workspace | `herdr {pane,tab,workspace} rename <id> '<label>'` |
| Move a pane | `herdr pane move <pane> --workspace <ws> --new-tab` |
| Swap two panes | `herdr pane swap <a> <b>` |

- **A prompt sent to a freshly started pane can be dropped silently.** A codex
  pane still initialising MCP clients (30 s+ when a server like an editor
  endpoint is down) reports `idle`, accepts `agent prompt` with `agent_status:
  idle`, and never runs it. `agent start` timing out (`timed out waiting for
  agent startup`) is the tell, but a "successful" start can do it too. After
  every dispatch to a new pane, confirm with
  `herdr agent wait <pane> --until working --timeout 60000` and re-send on
  timeout; do not rely on a sequential watcher loop to notice, since the
  first `--until working` wait just expires and the loop moves on.
