---
name: co-w
description: >-
  Follow along with a sibling Herdr agent pane: watch its progress and offer
  targeted help. Use when asked to follow along, /co-w, watch another pane,
  help that agent, or coordinate with a named Herdr pane while it works.
---

# co-w

## When to use this

Use this skill when the user asks you to co-work with, watch, help, steer, or
review a sibling agent running in a Herdr pane, especially in the form:

```bash
/co-w <herdr pane name or id>
```

Examples:

- `/co-w claude`
- `watch the claude pane and help if needed`
- `coordinate with w1:p3 while it finishes the refactor`

## Workflow

1. Confirm you are inside Herdr:

   ```bash
   test "${HERDR_ENV:-}" = "1"
   ```

   If this fails, say you are not running inside a Herdr-managed pane and stop.
   Do not inspect or control panes from outside Herdr.

2. Re-read live pane ids before acting:

   ```bash
   herdr pane list
   ```

   Pane ids are session-local and can compact when panes close. Match the user
   argument against the current pane id, title, command, label, or recent task
   text. If the match is ambiguous, ask for the exact pane id.

3. Inspect the target pane before sending anything:

   ```bash
   herdr pane read <pane> --source recent --lines 80
   ```

   Confirm what the agent is trying to do, whether it is currently working,
   blocked, done, or waiting for input, and which repo or directory it appears
   to be operating in.

4. Orient from the repo, not only the transcript. In the relevant working tree,
   inspect status, docs, tests, and touched files as needed. Do not revert or
   overwrite another agent's in-flight changes. Treat unexpected diffs as
   concurrent work unless the user explicitly says otherwise.

   If a Claude Code pane delegated to subagents and the parent transcript shows
   degraded or rate-limit summaries, audit the child artifacts instead of
   trusting the visible summary. The parent session JSONL under
   `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` identifies the session;
   child metadata and transcripts usually survive under
   `~/.claude/projects/<encoded-cwd>/<session-id>/subagents/`, with task output
   mirrors under `/private/tmp/claude-$(id -u)/<encoded-cwd>/<session-id>/tasks/`.
   Map metadata to task names, read the final child messages, then verify claims
   against the worktree with `git diff`, file existence checks, focused searches,
   and the relevant test command.

   A codex pane's transcript storage depends on the installed build. Take the
   thread id from `herdr pane list` (`agent_session.value`) and look for its
   rollout with `rg --files ~/.codex/sessions | rg '<id>'`; matching JSONL files
   can still be actively written. If no rollout exists, query
   `~/.codex/thread_history_1.sqlite`, table `thread_items` (`item_type` is one
   of `agentMessage`, `reasoning`, `commandExecution`, `fileChange`,
   `userMessage`; order by `rollout_ordinal`):

   ```bash
   sqlite3 ~/.codex/thread_history_1.sqlite \
     "select datetime(created_at_ms/1000,'unixepoch','localtime'), item_type, item_json
      from thread_items where thread_id='<id>' order by rollout_ordinal desc limit 30;"
   ```

   Native transcripts survive scrollback; compare the newest entry's timestamp
   against `date` to judge liveness. `~/.codex/session_index.jsonl` maps thread
   ids to names, but its `updated_at` tracks renames, not activity — never read
   liveness from it.
   `thread_turns.started_at` is likewise junk (renders as 1970).

5. Watch event-driven instead of polling terminal text. Prefer:

   ```bash
   herdr agent wait <pane> --timeout 120000
   herdr pane read <pane> --source recent --lines 120
   ```

   Omit `--until`: the default matches idle, done, or blocked. `--until done`
   misses a sibling that finished a turn as `idle` — same-tab follow-along is
   already seen, so it never becomes `done`.

   Use
   `herdr pane wait-output` only for a specific intermediate milestone such as a
   server-ready line, build result, or named phase checkpoint. If output wrapping
   makes matching or copying ambiguous, inspect with:

   ```bash
   herdr pane read <pane> --source recent-unwrapped --lines 120
   ```

6. Decide what help is actually useful:

   - If the target agent is on course, keep watching and avoid interrupting.
   - If it is missing repo guidance, canonical docs, a relevant skill, or a
     likely failing test, send a concise correction with the exact file,
     command, or constraint.
   - If it is blocked, answer the blocking question directly when local context
     is enough; otherwise surface the blocker to the user.
   - If it finished, review the result like a teammate: inspect diffs, run the
     focused verification that fits the risk, and report concrete findings.

7. Send feedback sparingly and explicitly:

   ```bash
   herdr agent prompt <pane> "Short, actionable note with file paths or commands." --wait --timeout 120000
   ```

   If this returns `agent_prompt_stalled`, read the pane before retrying: the
   failed submission can leave partial text in the composer. Clear only that
   unsent fragment with `herdr pane send-keys <pane> ctrl+u`, then use
   `pane send-text` plus a separate `Enter` and confirm the agent becomes
   `working`.

   Prefer one high-signal note over repeated commentary. Do not take over the
   other agent's prompt unless the user asked you to drive it.

8. If the session surfaced a durable lesson about a skill, run `reflect` — it
   owns the durability test, the routing, and what may be edited directly
   versus proposed.

9. Close with a coordination summary: what the watched pane is doing, whether
   you intervened, code or docs issues you found, verification performed, and
   any skill updates made.

## Notes

- Default target timeout is two minutes. If the agent is still working, re-arm
  another event wait rather than polling constantly.
- A codex pane's elapsed-turn counter ("Working 52m") is not evidence of a hang:
  a lead that armed `herdr agent wait --timeout 1800000` on a worker holds one
  turn open for the whole wait. Judge liveness by the gap between its newest
  transcript row and now, not by the counter.
- Read a fleet lead's context headroom off the pane footer ("17% context left")
  and say so. A lead near the floor is the fleet's real risk; check whether its
  coordination state is durable on disk (handoff briefs, receipts) before
  proposing an interrupt to checkpoint.
- A clankie pane carries no `agent_session`, so `herdr agent prompt` refuses it
  with `agent_not_ready`. Reach it with `pane send-text <pane> "<one line>"`
  then `pane send-keys <pane> Enter`, and read the pane to confirm the turn was
  accepted. Send one line: his composer submits on a newline.
- For multiple panes, arm one background waiter per pane and `wait` for them.
- Use `pane read --source recent` for human-readable context and
  `recent-unwrapped` for exact matching or copying.
- Identity comes from the roster, not from a message's own claim. A relayed line
  that says "I'm <pane>" is a hint, not an address: resolve the peer by durable
  name, read its pane to confirm the role matches before sending, and re-resolve
  the pane id at send time. When you message a peer, stamp your own name so they
  never have to trust a self-declared id.
- Never clean up another agent's work: no destructive git commands, no closing
  panes or agents, and no deleting run artifacts unless you created them or the
  user explicitly identified that target for cleanup.
- A codex pane showing an OpenAI "This content can't be shown / Trusted Access"
  banner had its turn killed by a provider refusal — it then sits `idle`
  mid-mission with no error. Treat idle-after-banner as stalled, not done, and
  harvest from durable state (the worktree's committed and uncommitted diffs,
  the tracker) rather than waking the pane, which may re-trip the same refusal.
- **Delivery is proven on the receiving side, never by the send call.**
  `herdr agent prompt` can return `timeout` (message queued; the lead was
  mid-turn), `agent_prompt_stalled` (partial text left in the composer), or
  `"agent_status":"idle"` (message dropped — a codex pane hung in MCP startup
  swallows it), and text sitting in an idle pane's composer is an undelivered
  instruction, not a record of one. After any send, confirm the status flips
  to `working` or the `›` line appears in `pane read --source recent-unwrapped`,
  or grep a distinctive phrase from your message in the target's transcript
  (`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` — encoded-cwd is the
  pane's own cwd, so a lane in a worktree lives under its own directory).
  Zero hits means it never arrived. Re-read before resending; a second send
  duplicates the note. On `agent_prompt_stalled`, clear only the unsent
  fragment with `pane send-keys <pane> ctrl+u`, then `pane send-text` plus a
  separate `Enter`.
- **Open the raw data before relaying another pane's numeric claim.** A summary
  travels further than the file it came from, and a wrong number in a relay
  becomes a wrong decision two panes away (one relayed "4.32°" was 40° in the
  linked file). Relay the pointer, and read the artifact before you assert its
  contents.
- A Claude pane whose composer holds an unsent operator draft must not be
  reached with `agent prompt`/`send-text`: both land in that composer. Use
  `ListAgents` and `SendMessage` instead; match the peer by its cwd/worktree
  name, stamp your own pane id in the message, and tell the lead you used the
  direct path so it knows the draft is intact.
