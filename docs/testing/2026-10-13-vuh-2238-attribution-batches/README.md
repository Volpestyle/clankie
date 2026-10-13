# VUH-2238: bounded fresh remote attribution batches

The [deployed diagnosis](../2026-10-13-vuh-2238-remote-proof-timing/README.md) measured process-probe queue p95 1556 ms, execution 665 ms, and repeated process proofs consuming 72.2% of captured serial execution. Roster remains over its one-second target.

Projection attribution now requests groups of at most four panes. Each first/last pass freshly reads host binding, kernel table and installed launchers once, while separately reading each pane's native agent/process information and kernel details. Each pane independently passes the original select/ancestry/birth/executable/workspace/fleet checks plus the observed occupant match. A malformed, missing, duplicate or changed pane row yields no proof for that pane; a group's transport/timeout failure yields no proofs for its panes. No previous call's proof/census is reused. Local and individual steering/bridge observers keep their original path. Retained hire, project and later tracker-scope validation remain unchanged.

The batch JSON includes only fields used by non-stream display validation; fresh Codex role detection remains, while dedicated-control endpoint/listener details stay on the existing individual control path. This keeps the generated Windows command under its unchanged native limit. Initial focused runs refused the oversized command (90 passed/7 failed); that failed evidence is retained. Corrected checks passed all97 cases, including independently refused wrong-occupant, reused-process, missing, duplicate and malformed entries while neighbours pass; whole-group error refusal after a previous successful call; changed-fleet refusal; and four/four/one grouping. Final checks passed all114 cases across three files after the completed wiring. Scoped format and lint passed. These are JSON trust-boundary checks, not native Windows E2E.

The lead-required independent native Codex subagent review found no blocking findings and made no edits. It reviewed the six source/test files against398efe735, including freshness, per-pane isolation, grouping and preservation of original guards. Windows execution, mixed-harness emitter behavior and actual relay output-limit handling remain unverified until lead deployment and a fresh five-minute window. No PC update/restart or live relay steering was performed. The exact landing gate is pending.

[Checks, initial refusals, source hashes and independent review](clankie://evidence/sha256/7d3d4206f70b6f1b4e937caf432b385951964c0de45f30d092ddddacb6fb4d99).

## Fixture type correction

The first exact gate failed at TypeScript TS2353: the new test's occupantIdForHerdrSession input literal included an unused agent property. Production types and code are unchanged. Removing that test-only field preserves the identity hash, which uses source/kind/value. The independent reviewer confirmed the correction and applicability of the original production review.

The lead-requested full service typecheck passed through heavy: source and all13 test programs,1041 total roots,133.44 seconds,exit0. The corrected proof test file passed all96 cases. The failed gate and corrected receipts are retained; the retry exact gate is pending.
