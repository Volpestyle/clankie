# Embedded Swarm retirement — VUH-1528

The retirement in public commit
[`f05ed249`](https://github.com/Volpestyle/clankie/commit/f05ed24982e7cad6b119395a7aea4869acd222b6)
implements phase 3 of [ADR 0213](../../adr/0213-clankie-retires-swarm.md).
The matching private app commit is
[`64e94c6`](https://github.com/Volpestyle/clankie-app/commit/64e94c609488ab225fd29eeb95270b1792cbe51a).

## Checks

Both repos' full `pnpm check` passed in exported source snapshots with their own
installed dependencies. The core snapshot contains exactly the retirement's
staged tree, including its parent VUH-1551 commit. The app snapshot contains
only committed app code, with that same staged core as a real sibling directory.
Dependencies were installed offline with scripts disabled and frozen lockfiles.
Checks disabled pnpm's dependency preflight after installation.

The check processes removed inherited `CLANKIE_`, `DISCORD_`, `HERDR_` and
`SWARM_` environment variables. These are host configuration, not fixture data:
the live route and voice/Discord overrides caused false failures in pairing and
configuration tests. No production settings were changed.

[Check excerpts](checks.txt) record the final suite totals. No tests were
excluded for the retirement. Evals and live hosted/release smoke were not run.
The shared checkout's separate claude2 and fresh-seat changes are outside these
snapshots and remain unstaged. Its intermediate full run also caught a Codex
cancellation fixture reaching the live service; that lane added a mock and its
six focused plugin tests then passed. The known claude2 help failure belongs to
that separate change. The two known persona-image failures did not recur with
host configuration removed from the isolated checks.

## Retained boundaries

Coordinator state under `~/.clankie/swarm`, saved conversations, and James's
personal Swarm installs, dotfiles and PC are untouched. Legacy personas load
without coordinator contact fields; retired task-bound grants are denied rather
than converted into manual authority. Manual grants, fleet grants and native
local/remote delivery remain supported. The worker plugin retains its MCP server
key `swarm` and bridge filename for installed hire permissions and PC clients.
The Discord swarm-home setting and historical ADR/test records remain separate
from the removed coordinator. No service restart or push was performed.

## Size

Tracked text physical lines in the shared checkout: 400,551 → 391,230
(9,321 fewer). The count reads the paths from `git ls-files`, skips missing
paths, directory links and files containing NUL bytes, and counts byte lines.
It includes concurrent tracked edits and this evidence; untracked work is excluded.
The implementation commit itself removes 9,945 net text lines.
