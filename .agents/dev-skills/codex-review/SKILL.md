---
name: codex-review
description: Use when you are the Codex reviewer on the owner's Mac and a lead asks you to review a pull request in clankie, clankie-app or clankie-ops, or when you build one and need its review. It covers preparing a read-only checkout of the exact head, posting every finding as one "Codex review", the advisory codex-clean status, and filing findings as follow-up issues.
---

# Codex review on the Mac

Pull requests in `Volpestyle/clankie`, `clankie-app` and `clankie-ops` can be
reviewed by a Codex worker on the owner's Mac, not by the cloud Codex bot
([ADR 0329](../../../docs/adr/0329-codex-reviews-on-the-owners-mac.md)). The
review posts under the Mac's `gh` login as one GitHub review headed
**Codex review**, and sets the `codex-clean` commit status on the exact commit
it read. The review is advisory: a pull request merges once its checks are
green, with or without it, and findings become follow-up issues
([ADR 0331](../../../docs/adr/0331-clankies-own-pull-requests-merge-on-green-checks.md)).

`scripts/codex-review.mjs` does the GitHub side. Run it from a clean clone of
clankie's `main` at `~/dev/.clankie-checks/codex-review/tools`
(`git -C ~/dev/.clankie-checks/codex-review/tools pull --ff-only` first), never
from `~/dev/clankie`. It needs Node 22+, git and an authenticated `gh`.

## As the reviewer

1. **Prepare.** `node scripts/codex-review.mjs prepare OWNER/REPO PR` fetches
   the head into its own worktree under `~/dev/.clankie-checks/codex-review/`,
   sets `codex-clean` to pending on that head, and prints JSON: the worktree,
   the merge base, the diff command, a findings file to fill, earlier Codex
   reviews on this pull request and the exact `post` command.
2. **Review the diff in that worktree, read-only.** Read the diff and the code
   around it. Run only the focused tests the change touches if a finding needs
   proof, through `clankie heavy --`; the pull request's own CI runs the full
   gate. Never push, commit or edit there.
3. **Report what would break.** A finding is a concrete defect a reader can
   check: wrong behaviour, a broken boundary from the repo's agent guide, a
   missing piece of what the pull request says it does, a security or privacy
   leak, or doc drift the change causes. Give each a priority (`P0` must not
   ship, `P1` breaks a real flow, `P2` wrong in an edge or misleading, `P3`
   worth fixing), a one-line title, and a body that says what fails and how to
   see it. `line` is the line in the pull request's version of `path`. Leave
   style preferences out. On a re-review, check each earlier finding against
   the new head and report only what is still wrong or newly wrong.
4. **Post once.** Write the findings file
   (`{"summary": "...", "findings": [...]}`; an empty list passes) and run the
   printed `post` command. It refuses if the head moved since prepare; then
   prepare again on the new head. Every finding lands in that one review;
   findings outside the diff go in its body.
5. **Tell the lead** the review link and the count, through Clankie.

Questions go to the lead that asked, never to the owner.

## As the builder or lead

- Open the pull request as a draft early and push often (ADR 0310).
- Merge once the checks are green; don't wait for a review.
- When a reviewer is free, ask it through Clankie (`message_agent` to its
  pane, or `message_seat`), naming `OWNER/REPO#N`. File each finding as a
  follow-up issue, or fix it in the same pull request if it hasn't merged.
- `node scripts/codex-review.mjs status OWNER/REPO PR` shows `codex-clean` for
  the current head and every other check.
- `node scripts/codex-review.mjs land OWNER/REPO PR` is optional: it merges
  (squash by default) only when the pull request is ready, `codex-clean` passed on its current head
  and every other check there finished green; a job skipped while the pull
  request was a draft counts as not run yet until the ready run replaces it. It
  merges against that exact head. A plain merge on green checks is the usual
  merge.
