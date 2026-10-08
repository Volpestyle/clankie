# Fresh worktree setup context: sibling-count refusal

The owner reported two fresh detached Codex hires refusing with
`Machine setup worktree could not be verified` on deployed `bf159323`.
The priority fix is separate from paused VUH-1742.

## Cause and change

The local Git worktree observer rejected a repository's entire registration
list when it contained more than 256 paths. At inspection the real Clankie
repository had 296 entries, including the clean, registered Iris checkout.
A newly created clean worktree reproduced setup-context unavailability through
the deployed fleet CLI. The count limit was introduced in `efed44136`, before
`cd7e50cf`, `cf9c5ae7` and `1e7499b1`; this investigation does not attribute
its introduction to those recent deployments.

Remove the arbitrary sibling-count refusal. The native Git command remains
bounded by its 512 KiB output limit and three-second timeout. Nonempty unique
registrations, canonical paths, the candidate's actual Git common directory,
admin-directory location, exact `.git` backlink and current registration remain
required. Both ends are still observed twice; no path-containment fallback or
saved/caller-supplied Git authority is introduced.

## Proof

[checks.txt](checks.txt) retains commands and read results. The regression
creates an owned empty Git repository, 255 sibling worktrees, then a fresh clean
detached worktree: 257 real registrations including main. It persists enrolled
root/settings policy, crosses the real TCP HTTP setup-context route and verifies
that project-specific commit/push policy applies. A normal folder inside the
namespace and a mismatched requested project still receive 409. Native Git,
filesystem, settings and resolver operations are not mocked; no harness starts.

A read-only production resolver probe checks the actual new source worktree and
Iris against enrolled owner settings. It prints selected path/policy facts only,
not credentials or full settings. Detailed metadata remains ignored in `.local/`.
The baseline and fixed outputs distinguish this source proof from the deployed
CLI, which still runs the old implementation until the owner deploys the SHA.

No project settings/enrollment, other worktrees, allocation ledger,
`project-hires.ts`, active panes, PC configuration or hosted deployment changed.
The owner must deploy this commit and retry the originally requested hire;
no real worker hire was made to prove the fix.
