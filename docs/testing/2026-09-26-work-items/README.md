# Work items in the repo's own convention (ADR 0191, VUH-1374)

Live proof, 2026-09-26, that `clankie work` follows each repo's existing
tracker, asks instead of guessing, and exposes only registered repos to devices.

**How it ran.** `flows/serve.mts` starts a throwaway instance of the real
`/v1/work` route and `work_*` dispatch ops (the owner's running service was
not restarted). Linear went through Clankie's connected account over MCP;
GitHub through the owner's `gh`. `flows/run.sh` drove the real `clankie work`
CLI. The harness was run from `apps/clankie` with its imports pointed at
`./src/` so workspace packages resolve; nothing else differs.

## Results (evidence/)

| Repo                            | Its convention                | What happened                                                                                                                                                                                                                                                                |
| ------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| scratch (fresh, only `TODO.md`) | none usable                   | `discover` returned the owner's question (a1); `create` refused with `needs_decision` (a2); `init --backend default` recorded the owner's answer (a3); items then went to `.clankie/work/` (a4–a6).                                                                          |
| `~/dev/portfolio` (private)     | GitHub issues (8 in use)      | Discovered as GitHub (b1). Created, progressed, attached evidence and closed as not planned: [Volpestyle/portfolio#47](https://github.com/Volpestyle/portfolio/issues/47) (b2–b5). No `.clankie/work` created (b6).                                                          |
| `~/dev/clankie`                 | Linear (VUH, Clankie project) | Discovered from `CLAUDE.md`, 18 issue links in docs and 100 distinct `VUH-*` keys (c1). Created [VUH-1376](https://linear.app/vuhlp/issue/VUH-1376), moved it to In Review with both criteria checked, attached evidence, canceled (c2–c6). No `.clankie/work` created (c7). |
| Device view                     | registered ids only           | `work_repos` listed the three registered repos with their backends (d1); `work_items` returned 158, 9 and 1 items (d2); an unregistered id was refused (d3).                                                                                                                 |

Discovery was also run read-only on `clankie-ops` (Linear: a linked project and
14 issue links in docs), `animforge` (Linear: 13 distinct `VUH-*` keys) and
`clankie-landing` (nothing, so the default). An earlier version mistook model
names in commit messages (`GROK-4`) for a Linear team; discovery now counts
distinct issue numbers per key, denies model and version prefixes, and reads
issue links in docs. Both cases are regression tests.

Side effects left in place, deliberately: `.clankie/tracking.json` in
`~/dev/portfolio` and `~/dev/clankie` (the recorded answer; each repo's owner
decides whether to commit it), portfolio#47 (closed, not planned), and
VUH-1376 (canceled).
