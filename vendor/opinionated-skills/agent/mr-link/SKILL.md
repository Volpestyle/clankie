---
name: mr-link
description: >-
  Commit, push, and hand back a create-MR/PR link plus a copy-paste command to run this
  worktree locally — then spin up an independent fresh-context reviewer on the pushed
  branch and adjudicate its findings. Works on GitLab and GitHub. Never opens the MR
  itself — the link is yours to click. Use when the user says /mr-link, "push and give me
  the link", "gimme the link", or wants the branch running locally after pushing.
---

# mr-link

`/c` → `/p` → **create-MR link** + **run-it-locally command** → independent review pass.

Composed on purpose: `/c` owns committing and rebasing, `/p` owns pushing. This skill owns
the link, the run command, and the review. Don't reimplement the first two.

## Guardrails

- **Never create the MR.** No `glab mr create`, no `gh pr create`, no
  `-o merge_request.create` push option. The whole point is a link the user clicks.
- **On the default branch → stop.** Nothing to MR.
- Runs no checks — that's the repo's own pre-MR check skill, if it has one. The one
  exception is a conflict resolution, which `/c` already owns verifying.

## Steps

1. **Locate.** `git rev-parse --show-toplevel`, `git branch --show-current`,
   `git remote get-url origin`. Bail per guardrails.
2. **`/c`** — commits anything uncommitted, fetches, and rebases only if the branch no
   longer merges clean. Skip if the tree is clean and `/c` already ran this session.
3. **`/p`** — pushes; force-with-leases itself if `/c`'s rebase rewrote history.
   **Keep the push output** — both hosts print the create link on stderr:
   - GitLab: a `.../-/merge_requests/new?...` URL
   - GitHub: a `.../pull/new/<branch>` URL

   That printed URL is authoritative. Prefer it over anything you construct.
4. **Fallback URL** — an already-pushed branch prints "Everything up-to-date" and no URL.
   Build it from the remote path (everything after `:` or the host, minus `.git`):
   - GitLab: `https://<host>/<path>/-/merge_requests/new?merge_request%5Bsource_branch%5D=<branch>`
   - GitHub: `https://<host>/<path>/compare/<default>...<branch>?expand=1`

   **Don't trust the host in the remote** — `git@gitlab-skills:…` and friends are SSH
   aliases from `~/.ssh/config`. Resolve the real one with `ssh -G <host> | grep '^hostname'`.
   **Don't trust a repo name from CLAUDE.md either** — read the path off the remote.
5. **Stacked branch** — if this sits on another feature branch rather than the default
   (`/c` will have flagged it), append the target so the MR doesn't default to main:
   - GitLab: `&merge_request%5Btarget_branch%5D=<parent>`
   - GitHub: the `compare/<parent>...<branch>` form already carries it.
6. **Dev command** (below), then output one block: link, cd+run command, localhost URL.
7. **Kick off the review pass** (below) — after the link is delivered, never before. The
   link must not wait on a review.

## The dev command

Discover, don't assume: read `package.json` scripts (`dev`, `start`), or the equivalent for
the stack. No dev script (serverless backends, libraries) → don't invent one; offer the
build/test command instead, and if a paired worktree for the same ticket exists, offer that.

- **Find a free port first.** Vite with `strictPort: true` hard-fails rather than falling
  back, and the main checkout usually holds the default:
  ```bash
  for p in $(seq 5173 5199); do lsof -nP -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 || { echo $p; break; }; done
  ```
  A CLI `--port` overrides the config.
- **Check the scheme** — a mkcert plugin in the vite config means `https://localhost:<p>`,
  not http. First run in a fresh worktree may prompt for sudo to install the cert.
- Missing `node_modules` in the worktree → prefix the install command.

## Independent review pass (after the link)

A fresh-context reviewer catches what the authoring context cannot: the author reads intent,
the reviewer reads what's actually written.

1. **Spawn** a reviewer with NO shared context, pointed at the pushed branch. Use the repo's
   review protocol if it has one (a repo-specific `review-mr-*` skill); otherwise `/code-review`.
   No MR needs to exist yet.
   - Claude Code: a background subagent; its completion notification is the watcher.
   - Inside herdr (`HERDR_ENV=1`): spawn a pane, wait on its done status via the herdr CLI.
2. **Harvest** the report on completion — notification/watcher, not busy-polling.
3. **Adjudicate** each finding against the authoring context. Three buckets:
   - **accepted** — it stands; state the smallest fix, do NOT apply it.
   - **disputed** — the reviewer is wrong, with evidence held to the same bar as the finding:
     a trace, a count, a file path. "I know what I meant" is not evidence — the authoring
     context is exactly where the blind spots live.
   - **deferred** — genuinely the user's call (product direction, claims neither side settles).
4. **Report** in one message: accepted / disputed / deferred, one line each, plus any
   verbatim validation items the reviewer flagged for a human. Then stop — no fixes, no
   force-pushes, no MR edits until asked.

## Output shape

Terse. This is a copy-paste handoff, not a report:

```
MR: <url>

cd <worktree> && pnpm dev --port 5174
→ https://localhost:5174
```
