---
name: interrogate
description: >-
  Multi-reviewer adversarial review of a diff or change, with a
  counter-adversarial judge. Use when asked for an adversarial, multi-reviewer,
  or multi-model review of a change — to challenge it, stress-test it, or find
  its blind spots — or on /interrogate. Not the push-then-review flow (mr-link).
---

# interrogate

Fan out 3–4 independent reviewers against the same diff, then you judge.
Nothing is auto-applied — report the buckets; the user (or the routing
mode) decides.

`mr-link` owns the push-then-review flow (one fresh-context reviewer after
the create-MR link). This skill owns reviewing any diff on request. Don't
push, don't open an MR, don't run `/c`/`/p`.

## When to use this

- User runs `/interrogate` (optionally scoped to a path, a diff, or a PR).
- Asked to stress-test, challenge, or tear apart a change.
- A single-reviewer pass already ran and you want independent second
  opinions, not another read of the same context.

## Workflow

1. **Scope.** User-pointed files or a named diff win. Else, on a feature
   branch, `git diff main...HEAD` (or the real base). Package the diff plus
   any surrounding files a reviewer needs to understand the change.

2. **State the intent** as one short paragraph *before spawning anything*,
   and fence it. Derive it from the user's message, commit messages, a PR
   description if one exists, and the code. Reviewers judge whether the
   code achieves the intent well, never whether the intent is right. If
   the intent is unclear, ask before proceeding.

3. **Fan out 3–4 independent reviewers.** Same prompt, same rubric, zero
   shared context. Don't tell them about each other. Spawn them all at
   once, not sequentially. Read-only.
   While they run, read the diff and `references/lead-judgment.md` yourself —
   step 4 needs your own read of the call sites and shouldn't start from zero
   when they return.

   - **Inside herdr** (`HERDR_ENV=1`): dispatch as panes of *different
     agent kinds* (codex, gemini, grok — real model-family diversity).
     Load `herdr` for pane split/wait. Launch with
     `herdr agent start <name> --kind <kind> --pane <new-pane>`, then
     `herdr agent prompt`. Anything longer than one line goes through a
     file; send a one-line pointer (`herdr-handoff`). `agent prompt`
     submits through the TUI; `pane run` mangles it.
   - **Outside herdr:** background subagents — independent fresh contexts
     still beat one reviewer, even when the harness only has one model
     family. Prefer distinct families when the harness offers them.

4. **Judge** after all reviewers return (or say who timed out). You are
   the lead, not a fifth spawned judge. Read
   [`references/lead-judgment.md`](references/lead-judgment.md) and bucket
   every finding. **Act on** holds only what would actually block the PR — a
   list the user can fix and ship, not a ranking. Never drop **Dismissed**.

5. **Report** in the shape below. Then stop — no fixes until asked.

## Reviewer prompt

Fill this template. Every reviewer gets the same filled copy.

```
You are an adversary, not a cheerleader. Find real problems: bugs, design
flaws, security issues, maintainability. "no findings" is a valid result —
never pad.

## Intent
> {INTENT}

Review whether the code achieves this intent well. Do not question the
intent itself.

## Code under review
{DIFF_OR_FILES}

For each finding:
- **Severity**: `critical` | `warning` | `nit`
- **Location**: file:line (or function)
- **Finding**: what's wrong, in concrete terms
- **Evidence**: why you believe it; show the path. Don't just assert.

Read-only. Do not edit files, commit, or "fix" anything. If you find
nothing, say "no findings" and stop.
```

## Output

### Intent
> the fenced paragraph from step 2

### Reviewers
- Reviewer [kind/label]: [N findings] (one bullet each)

### Act On
Real issues that would block a PR. Each: description, who raised it, why
it matters.

### Consider
Legitimate, but you're not sure they outweigh the cost right now.

### Noted
Technically valid, not actionable at this stage.

### Dismissed
Rejected findings with a **one-line reason each**. This is a trust
mechanism — never drop the section.

### Agreement Map
Which findings 2+ independent reviewers raised (high confidence) vs
lone-reviewer findings. Merge paraphrases of the same issue; note
disagreements.

## Notes

- Don't pad. An all-nits round means the code is probably fine — say so.
- Security and correctness get extra scrutiny even from a single reviewer.
- Complements `/robust-review` (maintainability lens, one reviewer) and
  `/blast-radius` (prove the one safety fact by running code). Don't
  collapse those jobs into this one.
