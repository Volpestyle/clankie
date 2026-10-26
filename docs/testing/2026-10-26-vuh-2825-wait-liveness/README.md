# VUH-2825 source candidate and remaining acceptance

2026-10-26. Based on fetched origin/main `a4759c62229d6cfffde19613d2f41efd9d546c79` in branch `vuh2825-waits-20261026`. This is a separable SOURCE candidate, not full VUH-2825 acceptance or installed-runtime proof. Exact candidate SHA and review/gate results belong in the delivery receipt.

The public `clankie integrate status UUID --wait` now waits through active queue states to actual settlement using the existing CLI wait behavior. Immediate status, terminal results, cancellation/refusal and request timeout behavior remain. The real CLI→HTTP→integration queue→Git remote test holds pushing, verifies the waiter remains blocked, resumes, and verifies the remote main.

Simulator renewal retains exact native identity/session/process-birth guards. A live exact holder can renew through finite native activity or queued/held heavy work with validated native ancestry. Native prompt time begins idle expiry; explicit touch remains available. Evidence loss expires; unknown/replayed/stale/future/replaced/dead identity cannot become immortal activity. Caps, runaway protection, cleanup and shutdown remain independent.

| Native holder      | Turn activity source proof                                                   | Queued/held heavy proof                      |
| ------------------ | ---------------------------------------------------------------------------- | -------------------------------------------- |
| Codex root         | Implemented; read-only native RPC/controller fixture                         | Exact native process ancestry fixture passed |
| Codex child        | Implemented; verified parentThreadId chain to original root                  | Exact native process ancestry fixture passed |
| Claude root        | **REQUIRED / OPEN: no verified public native root discriminator**            | Exact native process ancestry fixture passed |
| Claude local child | Implemented; original mod timer→helper→authenticated admission→lease fixture | Exact native process ancestry fixture passed |

Heavy proof covers root and child native-holder shapes; it does not separately launch each real harness. Turn proofs exercise source/native wire contracts with fixture native processes. No actual Claude/Codex harness, running service, plugin reload or CoreSimulator was launched. The simulator adapter uses a subprocess surrogate; kernel process identities, TCP ownership admission, HTTP routes and governor are real. Installed-runtime acceptance stays GLOBAL-owned after rollout.

## Native Claude boundary and corrected assumption

Read-only inventory inspected installed Claude Code 2.1.310 (`/Users/james/.local/share/claude/versions/2.1.310`), without launching it. `native-api-snippets.txt` preserves byte-offset excerpts: agent.list implementation at 229065089; local/teammate projection at 225905431; task status at 229064311; turn events around 233538xxx; root caller at 233599954; agent API exports at 219913941. List IDs identify local tasks; `type` is an agent ROLE, not a local-agent discriminator. Teammates are excluded. Root turn events can carry a generated agentId, so absence from agent.list, missing Stop, or an ID heuristic cannot prove root activity.

Earlier `native-proof-r3.log` and the root portion of `focused-native-cli.log` used an invalid surrogate root-classification assumption. They are retained as **SUPERSEDED, NOT root proof**. The final fixture uses the actual child shape (`type: general-purpose`), proves a generated root ID does not renew, and preserves the required root gap. The smallest missing boundary is an original-native positive root turn discriminator/current activity source; this candidate does not invent one.

## Checks and captures

Raw captures are uploaded through `clankie evidence push`; only this README and evidence.json are committed. The archive includes exact command logs, scratch runner and inspected API snippets. HOME, USERPROFILE, every XDG root, CODEX_HOME and CLAUDE_CONFIG_DIR are confined to scratch for focused fixture commands. Fixtures use native process surrogates and release/terminate their own resources.

Final unchanged source snapshot:

- `clankie heavy -- node .local/vuh2825/run-check.mjs pnpm exec vitest run apps/clankie/test/resource-wait-liveness.integration.test.ts apps/clankie/test/claude-tool-catalog-mod.integration.test.ts apps/clankie/test/codex-hired-seat-protocol.integration.test.ts`: **36/36 passed**, 3 files, 37.06 seconds (`candidate-focused.log`). Quiet child activity advances more than ten simulated minutes through the original mod timer; prompt expiry, loss, replay, future/stale evidence, replacement/death, queued/held ancestry and false-label negatives are checked.
- `clankie heavy -- pnpm lint:files` with the 22 explicit owned source/test paths recorded in `candidate-lint.log`: **passed**.
- Plugin mirror regeneration: `clankie heavy -- node integrations/claude-plugin/build.mjs` (`plugin-candidate.log`).
- Resource typecheck passed (`resources-typecheck-r2.log`). Service source and all 15 test typecheck shards passed (`final-service-typecheck.log`, 213.94 seconds); later fixture assertions were added, so this is supporting evidence rather than an exact final-tree gate.
- Six-file integration regression run: **149 tests passed** (`final-focused.log`, 368.49 seconds). Source changed during that run; treat it as supporting regression evidence. It includes the real public integration CLI waiter proof. Earlier focused CLI run also passed that unchanged waiter behavior.
- Earlier failures are retained: operator/native listener fixture mismatch, 30-second timeout, invalid producer takeover ordering, lint unused fixture variable, and exact-optional/fixture typecheck errors. They were fixed without relaxing deadlines/assertions. No earlier failed or superseded root assumption is promoted to a pass.

Required independent exact-patch approval and root `clankie heavy -- pnpm check:landing` / revalidate remain mandatory. See delivery receipt for their actual outcomes; this document does not assert them green.

## Foreground sleep baseline and missing post day

Reused the original-week audit and already retained VUH-2826 native token-ledger capture; did not rerun the week scan. Retained source: `docs/testing/2026-10-26-vuh-2826-token-ledger/evidence.json`, raw usage `clankie://evidence/sha256/ebc3b923042813fa0613a424855444c45b53c6a01d68627aa4fd591bae649a5a`.

Corpus interval: `[2026-10-18T01:40:00.000Z, 2026-10-25T01:41:00.000Z)`, UTC boundaries, 1,984 files / 10,762,413,314 bytes, 65,387 calls. Literal executable foreground-sleep detector over available native transcripts: 4,060 calls (lead 63, workers 3,723, subagents 203, unknown role 71). Missing transcripts are not zeroes. Nine malformed/incomplete-line warnings and ambiguous Codex snapshot aliases remain limitations. The original audit's approximately 3,300 Claude loops used a different corpus/detector; it is not directly comparable to this broader retained native ledger.

| UTC day          | Known workers |       Subagents | Unknown role | Lead |
| ---------------- | ------------: | --------------: | -----------: | ---: |
| Oct 18 (partial) |           438 |             170 |           49 |    0 |
| Oct 19           |           139 |               2 |           16 |    5 |
| Oct 20           |          1089 |               1 |            2 |   20 |
| Oct 21           |           460 |               6 |            0 |    9 |
| Oct 22           |           119 |               0 |            0 |    3 |
| Oct 23           |           693 |              24 |            0 |   17 |
| Oct 24           |           782 |               0 |            0 |    7 |
| Oct 25 (partial) |             3 | no retained row |            4 |    2 |

Six full UTC days (Oct 19–24): known workers 3,282 / 6 = **547/day**; workers plus subagents 3,315 / 6 = **552.5/day**. Unknown roles stay separate. Partial endpoints are excluded from these daily averages.

**Remaining acceptance:** after GLOBAL rollout, measure a complete post-deployment UTC day with the same native-transcript method and disclose coverage. No such day exists for this source-only candidate. There is no post-day zero or reduction claim. Claude root turn-only source coverage and installed-runtime matrix acceptance also remain open; lead closes the issue only after accepted delivery.
