---
name: herdr-handoff
description: >-
  Hand off a full conversation/work-session context to another agent pane in
  herdr: write a handoff file, pick or spawn the receiving pane, send a
  one-line kickoff prompt, verify pickup. Use when asked to pass work to
  another pane, continue a session in a fresh agent, or brief a sibling agent
  on everything so far.
---

# herdr-handoff

Pass an entire work session to another agent pane without losing the parts a
fresh context cannot re-derive.

Use this for an actual context or ownership transfer. Routine progress updates
the existing brief or issue via `linear-issues`; it does not create another
handoff packet. Link retained evidence instead of duplicating it. Confirm pickup
once at the ownership boundary, not after every result or status delta.

Requires `HERDR_ENV=1`. If it is not set, say you are not running inside herdr
and stop. Load the `herdr` skill for the full CLI reference; only the
handoff-specific incantations are repeated here.

## Core rule: the file is the channel

Never push session context through `pane send-text` / `pane run`. Terminal
input mangles long multi-line text, and agent TUI input boxes truncate or
misparse it. Write a handoff file to disk, then send the receiver a single-line
kickoff prompt pointing at it. The file carries the context; the prompt only
delivers the pointer.

## 1. Write the handoff file

Location: `~/.herdr-handoffs/` — predictable for any pane, survives session
scratchpad cleanup, timestamped names avoid collisions.

```bash
mkdir -p ~/.herdr-handoffs
HANDOFF=~/.herdr-handoffs/$(date -u +%Y%m%dT%H%M%SZ)-<task-slug>.md
```

Every path the handoff references must outlive your session. If it cites
artifacts in ephemeral locations — session scratchpads, `/tmp`, anything
cleaned between sessions — copy them into an assets dir beside the file and
reference the copies, not the originals. A pointer back into the scratchpad
defeats the reason this file lives in `~/.herdr-handoffs/` at all.

```bash
ASSETS=${HANDOFF%.md}-assets
mkdir -p "$ASSETS"
cp <scratchpad-draft>.md "$ASSETS"/
```

Template:

```markdown
# Handoff: <task title>

From pane <your pane id>, <absolute date/time>.
Goal of the session: <one or two sentences>.

## Status
What is done, what is mid-flight, what is untouched.

## Decisions (cannot be re-derived)
- What the user decided or approved, and why.
- Approaches tried and rejected, and why — this prevents the receiver
  from re-walking dead ends.
- Constraints the user stated that live nowhere else.

## Work state
- Repo/worktree path, branch, dirty or untracked files, stashes.
- Anything uncommitted the receiver must not lose.
- Long-running processes left in other panes (pane id + what it runs).
  Never omit this line — write "none" if there are none. Check
  `herdr pane list` before claiming none; a dev server you stopped
  noticing is still state the receiver inherits.

## Verification state
What was tested and exactly how; what is unverified. Never let "done"
imply "verified" — the receiver will assume it does.

## Gotchas learned this session
Environment quirks, failing commands and their fixes, anything that cost
real cycles to discover.

## Next steps (ordered)
1. The immediate next action, concrete enough to start on.
2. ...

## Pointers
Linear issues, MR/PR URLs, key `file:line` references, skills the
receiver should load before starting.
```

Content rules — what earns a line:

- Include only what the receiver cannot re-derive: user decisions, rejected
  approaches with reasons, uncommitted state, verification status, discovered
  gotchas, stated constraints.
- Exclude anything the repo already records — do not replay the transcript,
  paste code that is on disk, or summarize what `git log`/`git diff` shows.
  Point at it instead.
- Convert relative time references ("earlier", "yesterday") to absolute dates;
  the receiver has no shared timeline with you.
- Name the project/team skills the receiver needs — a fresh agent will not
  know to load them.
- Include your own pane id so the receiver can ask questions back.

## 2. Pick or spawn the receiving pane

Always re-read ids first — closed IDs are not reused; moving a pane changes its workspace-qualified ID:

```bash
herdr pane list
```

**Existing agent pane:** only send to a pane whose `agent_status` is `idle` or
`done`. Sending to a `working` pane injects text into its input mid-task. Read
the pane first (`herdr agent read <pane> --source recent-unwrapped --lines 40`):
an `idle` pane may have just asked the user a question, and prompting it
clobbers that pending decision. If it is working, wait:

```bash
herdr agent wait <pane> --timeout 300000   # bare: matches idle, done, or blocked
```

**Fresh pane:** split, then `agent start` — it waits for real interactive
readiness, so nothing is sent before the TUI is up:

```bash
NEW_PANE=$(herdr pane split <your-pane> --direction right --no-focus | python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["pane"]["pane_id"])')
herdr agent start worker --kind claude --pane "$NEW_PANE"
```

`--kind` also accepts codex, gemini, cursor, opencode, copilot, amp, droid.

## 3. Send the kickoff prompt

One line, single-quoted (no embedded quotes or backticks — it passes through
the shell), delivered with `agent prompt`, which submits through the agent's
input box and includes Enter:

```bash
herdr agent prompt "$NEW_PANE" 'Read '"$HANDOFF"' in full before doing anything - it is a handoff of an in-progress session. Verify its described repo/branch/dirty state against reality (it may have drifted), then state your plan before changing files. I am in pane <your pane id> if anything is unclear.'
```

The three instructions in the prompt matter: read the whole file first, verify
described state against reality (handoffs go stale between writing and
pickup), and plan before mutating.

## 4. Verify pickup, stay reachable

Delivery is not pickup. Confirm the receiver is actually reading the file:

```bash
herdr pane wait-output --match "$(basename "$HANDOFF")" --timeout 60000 "$NEW_PANE"
herdr pane read "$NEW_PANE" --source recent --lines 40
```

Do not end your session the moment the prompt is sent — stay available until
the receiver has confirmed the handoff makes sense, since a closed pane cannot
answer questions. Report to the user: the handoff file path, the receiving
pane id, and what the receiver said it will do.
