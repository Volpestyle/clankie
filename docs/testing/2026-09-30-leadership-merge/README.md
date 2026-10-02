# VUH-1457 leadership merge

Scope: merge `lead`, `swarm-lead` and `herdr-lead` into `lead`, including cut audit
C23's vendored dashboard removal. Judging other opinionated skills remains on
hold; this evidence does not close the full issue.

The live `clankie skills` catalog changed from **35 to 33** entries:
**22 to 20 opinionated**, with **13 product/tool** entries unchanged. `lead` is
now the only leadership entry. Shared ownership, review, integration, tracker
identity and delivery guidance appear once; Swarm-first coordination and the
explicit Herdr fallback remain sections of that skill.

The source manifest records the local merge against the pinned upstream revision.
Herdr roles and CLI operations now live under `lead/reference`; dashboard code,
its auxiliary modules and board-only references are removed. The optional,
separately installed dashboard command remains supported by Clankie's Herdr
integration. The old npm archive remains pinned source provenance, not the catalog; release
assembly no longer copies it into the runtime dependency tree.

Validation on 2026-09-30:

- Catalog, root filtering, worker projections and skill-name display: 4 test
  files, 17 tests passed. Tests cover opinionated on/off, individual exclusion,
  and stale global leadership names in Pi and Codex discovery.
- Release assembly: 2 tests passed after removing the legacy skill archive from
  the relocated runtime copy, including a real Swarm enrollment/bootstrap.
- All four projections (`.agents/skills`, Claude operator, Codex operator and
  Claude worker) contain 33 skills, only `lead` among the three former leadership
  names, all four leadership Markdown references, and no dashboard plugin.
- Leadership supporting-file links resolve. Both seat generators pass `--check`;
  the Claude and Codex seats were regenerated from the captain instructions.
- `pnpm check`: the retry passed formatting, lint, dead-code, docs,
  infrastructure and all 27 typechecks. Vitest finished with **383 files passed,
  2 failed; 3263 tests passed, 3 failed, 2 skipped**. The three failures are in
  concurrent VUH-1478/VUH-1479 work: the folder-trust assertion in
  `hire-brief-receipt.test.ts` and both lazy-join cases in `play-voice.test.ts`.
  Those owners were notified; their changes were not included in this merge.
  The initial attempt had stopped at the concurrent seat-control type changes.
  The Vox checks after Vitest were not reached by this run.
- After the owners committed their corrections, a targeted rerun of both failed
  files passed **22 tests**. The remaining Vox suite passed **123 tests**, and
  the Vox IPC debug smoke passed. Existing successful full-suite results were
  reused; the entire `pnpm check` command was not repeated a third time.

[Focused output](focused.txt), [release output](release.txt) and
[full-check summary](check-summary.txt) retain
these results. The full check ran against a shared checkout with in-flight seat
and play edits; it is not a clean-checkout proof of this commit alone.

No release, push or deployment was performed. This is a source and local-loader
check, not a newly assembled installer or a hosted-image canary.
