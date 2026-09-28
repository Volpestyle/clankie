---
name: pr-description
description: >-
  Draft PR/MR descriptions by diffing the current branch against its default branch. Works with
  any git host (GitHub, GitLab, etc.). Use when the user asks to write, draft, or
  update a PR/MR description, open a PR/MR, or summarize what a branch changes for
  review.
---

# pr-description

Draft a PR/MR description for the current branch, then create or update the PR/MR
with it. The repo's git host determines the tooling — detect it, don't assume
GitHub (see [Detecting the git host](#detecting-the-git-host)).

## Core principle: diff the branch against the default branch

The description always describes **how the current branch differs from the
default branch** — nothing else. That branch is the ground truth; the PR is the
delta on top of it.

- Compare against the default branch, not against the last commit, not the working tree, and
  not what an individual commit message claims.
- Use the full branch-vs-default diff so the description reflects the *net* change a
  reviewer will merge — intermediate churn that cancels out should not appear.

Always work from the actual diff. Do not describe changes from memory or from the
conversation alone.

```sh
base=$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's|^origin/||')   # main, master, develop… — resolve, don't assume
git fetch origin "$base"
git diff --stat origin/"$base"...HEAD          # scope: which files changed
git diff origin/"$base"...HEAD                 # the net delta to describe
git log --oneline origin/"$base"..HEAD         # commits, for context only
```

(`A...B` shows the diff from the merge-base, i.e. the true branch delta.)
Stacked on a parent branch? Diff and target the parent, or the description
carries the parent's changes too.

## Detecting the git host

This skill is host-agnostic. Before creating or editing, detect where `origin`
points and use the matching CLI — never assume GitHub:

```sh
git remote get-url origin    # github.com → gh, gitlab.com/self-hosted GitLab → glab
```

| Host | Tool | Create | Update body | "PR" is called |
|------|------|--------|-------------|----------------|
| GitHub | `gh` | `gh pr create --base "$base" --title "<t>" --body-file <f>` | `gh pr edit --body-file <f>` | Pull Request |
| GitLab | `glab` | `glab mr create --target-branch "$base" --title "<t>" --description "<d>"` | `glab mr update --description "<d>"` | Merge Request |

Notes:
- A GitLab `git push` often prints an MR URL in its output — an MR may already
  exist for the branch. Prefer updating it over creating a new one.
- If the matching CLI isn't installed or isn't authenticated, say so and offer to
  hand the user the finished markdown to paste into the web UI instead.
- Use the project's term (PR vs MR) when talking to the user.

## Picking the format

Decide based on what the branch does; a branch that both fixes and adds uses the
feature format with the root cause folded into What changed. The user sees the
draft before anything is posted, so pick and proceed.

### Bug fix

```markdown
## Issue
<What the user-visible problem was — the symptom, who hit it, when.>

## Root cause
<The underlying reason in the code. Reference files/functions.>

## Fix
<What this branch changes to resolve it, tied back to the root cause.>
```

### Feature / general change

```markdown
## Summary
<One or two sentences: what this branch does and why, framed as the delta over the default branch.>

## What changed
<Bulleted list of the meaningful changes vs the default branch. Group by area if large.
Skip noise (formatting-only churn, lockfile bumps) unless it matters to a reviewer.>

## GIFs
<Only include this section if the user supplies GIFs/screenshots. Otherwise omit it entirely.>
```

## Writing guidance

- **Summary** = the "what + why" at a glance. **What changed** = the concrete delta.
- Write for a reviewer who knows the codebase but not this branch.
- Be specific: name the components, files, schemas, or endpoints touched.
- Describe behavior and intent, not a file-by-file changelog of the diff.
- Match the repo's voice. For a backend-heavy repo, surface schema reuse and
  contract drift concerns when relevant.
- Never invent a "GIFs" section, testing notes, or screenshots the user didn't give you.

## Workflow

Diff, detect the host, pick the format, draft — then show the draft and create
or update the PR/MR only after the user approves it. Pass multi-line bodies via
a file (`--body-file` / `--description "$(cat <f>)"`) or a heredoc, not an
inline string.

## Notes

- Follow whatever attribution rules the session imposes on commit messages and
  PR/MR bodies; don't add or strip attribution on your own.
- If the branch already has an open PR/MR, prefer editing its body over making a new one.
