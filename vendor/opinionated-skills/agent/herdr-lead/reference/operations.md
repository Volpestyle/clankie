# Herdr lead operations

Read the sections needed for the operation; the lead workflow stays in
[SKILL.md](../SKILL.md). Dispatch authority and ownership rules apply here too.

## Census

One call gets the whole session. Do not loop `workspace list` / `tab list` /
`pane list` — `api snapshot` already contains all of it plus focus and layout.

```bash
herdr-lead roster
```

That renders the snapshot as a compact roster (13 panes ≈ 20 lines) with a
collection timestamp, status summary, shared-cwd warnings, and your own pane marked.
The timestamp dates the snapshot, not task completion; `done` and `blocked`
require inspection before harvest or escalation. Raw
`herdr api snapshot` is several hundred lines of JSON per dozen panes — only
reach for it (`herdr-lead roster --json`) when you need a field the roster drops.

Useful filters: `--agents-only` (skip plain shells), `--status done`.

When the board is up and a lane's outcome, owner, or blocker changes, update
`summaries.json` — see **Agent summaries**. Do not rewrite unchanged summaries
after every read, or write them with no board open.

### Open the live board

**Only when asked.** The board is opt-in: open it when the invocation carries
`board` (`/herdr-lead board`, `$herdr-lead board`) or the user asks for the
board/dashboard in words. Otherwise skip it and go straight to the text census —
an unasked-for pane rearranges the user's screen. Prefer the split:

```bash
herdr-lead split
```

`~/.local/bin/herdr-lead`, symlinked to `plugin/cli.ts`. `herdr-lead split`
puts the board in a pane beside the target (the pane that invoked it when
one did; otherwise the focused pane) and records that pane as the peer
`ctrl+b shift+L` / `herdr-lead focus` returns to. `herdr-lead state` is the
digest below.

**Never run bare `herdr-lead` from a tool call or a service.** It paints the
TUI into the calling process — from an agent's Bash tool that means a TUI in
captured stdout, which hangs or wastes the call and shows the user nothing.
Only a human typed into a shell should run it that way; use `herdr-lead split`.

**One board per session.** Both forms are idempotent: if a pane labelled `Herd
Lead` is already up, they print its pane id and open nothing. So a second lead
agent invoking this skill never spawns a duplicate board — it inherits the one
the user is already looking at. Tell the user where it is rather than trying to
open another.

One-time install and the `prefix+shift+l` keybinding: [install.md](install.md).
Board views, keys, scan roots, env vars, and what `r`/`R`/`p`/`P` do:
[board.md](board.md) — the board is the user's view and `?` inside it prints
the keymap, so you never recite it. Two things the board does *not* do: call
Datadog or Linear (you write those caches — next section) or prompt an
existing agent (dispatch stays yours, within the authorization in the lead skill).

### The two agent-written caches

The board never calls Datadog or Linear — it has no credentials. The `datadog`
view (key `6`) and the header's `+K no branch` ticket count both render caches
**you** write, in `~/.local/state/herdr/plugins/herd-lead/`. `R` rereads them
from disk; nothing but you ever rewrites them.

The view opens with a LINKS section — whatever dashboards and explorer urls are
configured — and `enter` opens one in the browser. Links work with no cache at
all; set them with `c` → datadog quick links, or
`HERD_LEAD_DD_DASHBOARDS="label=url label=url"` (URL-encode spaces — the list splits
on whitespace), or a `"dashboards"` array in the cache.

Refresh them during a census when prod or ticket state matters, and whenever the
board shows them stale (the roll-up turns yellow past 30 minutes). Say the age
whenever you report from either — a clear board that is four hours old says
nothing about now.

**Before writing either file, read [board-caches.md](board-caches.md)**:
exact JSON schema for both, which MCP calls fill them, and the traps —
`No Data` is a resting state not a fault, a metric with no series means zero not
missing, and linear.json must be a superset or the board's join has nothing to
work with.

### Agent summaries

The board's `i` on an agent row shows the summary **you** wrote. Update it on
meaningful state changes, alongside the harvest rather than in a separate
reporting pass.

`~/.local/state/herdr/plugins/herd-lead/summaries.json`:

```json
{
  "at": "<ISO 8601 now>",
  "agents": {
    "w15:p8": {
      "summary": "Inspecting the herdr census so seated turns carry the fleet.",
      "next": "Show those summaries on i.",
      "at": "<ISO 8601 now>"
    }
  }
}
```

One line for `summary`, optional `next`. Your words, not a pasted title or
a raw `※ recap:`. Merge by pane id — read the file first, update the panes
you know about, leave the rest. Do not drop siblings. `r` / `R` reread the
file. A missing entry shows as `no summary yet`. The recap the board mines
from a Claude pane is a fallback, not the summary.

### Read the board's exact state

The board publishes the data it renders, so you can know exactly what the user
is looking at instead of re-deriving it:

```bash
node ~/.claude/skills/herdr-lead/plugin/digest.ts
```

A compact digest: agents with their correlated worktrees, open editors, every
worktree with branch / dirty / ahead / behind / MR / attached panes, and the
skill library. `--json` for the full structure, `--fresh` to force a rescan,
`--all` to stop eliding.

**The text digest lists only worktrees that are doing something** — dirty,
ahead, behind, with an MR, or with a pane attached — and ends the section with
`… N clean/idle worktrees not listed`. Never conclude a repo is missing from
that output; it is almost certainly just clean. `--all` and `--json` are
complete. It reads the same config as the board (settings.json, then
`HERD_LEAD_*` env), so it works headless too.

It reads the board's live snapshot when the board is running (rewritten on every
refresh) and otherwise computes the same thing itself, so it works either way.
Prefer it over `roster.ts` whenever worktree or MR state matters; `roster.ts` is
still the cheaper call when you only need pane status.

Two caveats before you report anything from it. Git state compares against local
remote-tracking refs; the worktree detail labels them cached and shows the last
fetch time. Refresh the selected repo from its menu before relying on origin
state. Library `vcs` state never fetches, so a skill merged upstream since the
last fetch can still read as off-main. And a branch whose prefix is not in the
configured linear team keys (`c` on the board, or `HERD_LEAD_LINEAR_TEAMS` —
there is no default) gets no branch ticket at all, never a wrong one.

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
No metadata field exposes it. `roster.ts --recaps` flags it as
`!! UNSUBMITTED INPUT`.

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

Claude's TUI emits a `※ recap: <goal>. Next: <action>.` line — precisely what a
lead needs, in one line instead of a transcript. Get every agent's recap plus an
unsubmitted-input check in one call:

```bash
herdr-lead roster --recaps
```

This is one `herdr agent read` per agent pane, but it returns ~1 line each
rather than ~30. Reach for it before any manual reading. Best effort, not a
guarantee: recaps are a Claude-TUI feature, users can disable them, and other
agent kinds (codex, gemini) have no equivalent — an agent with no recap needs a
real read.

Recaps also go stale. They describe the pane's last turn, which may be from
hours ago; verify against a fresh read before acting on anything consequential.

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

**Swarm first for enrolled seats.** When workers were launched through the swarm
launchers (`swarm-claude`/`swarm-codex`), put the substance of every assignment,
answer and decision in `swarm_send` (durable, threaded, leased and acknowledged)
and use herdr only to wake or inspect the pane:

- Address the recipient by **actor UUID** from `swarm_find kind=peers`, never by
  pane or lane name; an unknown recipient string is accepted and silently strands.
- Claude seats receive through launcher hooks at turn boundaries (the lead's own
  replies arrive that way too, so a manual `swarm_inbox fetch` can come back empty
  while the hook holds the lease). Codex seats have native MCP but **no autonomous
  delivery**: after `swarm_send`, wake the pane with a one-line `herdr agent prompt`
  that carries no content ("Swarm inbox: thread <id>; fetch, ack and reply").
- A Codex seat whose swarm calls fail with `Transport closed` has lost its MCP
  child for good; Codex does not restart it. Repair when idle: `/quit` in the pane,
  then rerun `swarm-codex ... -- <model flags> resume <codex-thread-id>` (the id
  Codex prints on quit). The conversation survives, but the seat re-enrols as a
  **new actor**: look it up again with `swarm_find` before sending. A probe
  (fetch, ack, reply) confirms the repair.

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
| Live board, in this pane (human only) | `herdr-lead` |
| Live board, split beside the target (only if asked) | `herdr-lead split` |
| Board state (agents + worktrees + editors + library) | `herdr-lead state` |
| Same, full structure | `herdr-lead state --json` |
| Whole session, compact | `herdr-lead roster` |
| Goals + next steps + stranded input | `herdr-lead roster --recaps` |
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
