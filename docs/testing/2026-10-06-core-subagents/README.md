# VUH-1530: existing core subagent verification

The existing core at `26a4c8a19afae9f47d9aa584e529f00a8a715fd5` implements
Codex/Claude discovery and lifecycle projection plus read-only native child
history through the already-addressed parent. On 2026-10-06, **30 tests in
5 files passed**, with no failures or skips. Protocol and Clankie typechecks
and scoped lint passed. This verification adds evidence only; no production
code changed and no full `pnpm check` ran.

Worktree: `~/dev/clankie-wt/bex-vuh-1530-core-subagents`, branch
`bex/vuh-1530-core-subagents`. Its initial status was clean. Dependencies came
from a real isolated `pnpm install --frozen-lockfile`, with no shared
`node_modules` symlink. Install, tests and typechecks ran through the assigned
fleet-wide heavy-work wrapper. Compact results are in [checks.json](checks.json).
Ignored raw output and the Vitest JSON report remain in `.local/subagents-proof/`.

## Executed checks

From the worktree root:

```sh
/Users/james/.herdr-handoffs/clankie-backlog-20261003/bin/heavy pnpm install --frozen-lockfile
/Users/james/.herdr-handoffs/clankie-backlog-20261003/bin/heavy pnpm exec vitest run --config vitest.config.ts apps/clankie/test/codex-subagents.test.ts apps/clankie/test/subagent-native-history.integration.test.ts apps/clankie/test/seat-subagents.test.ts apps/clankie/test/captain-native-subagents.test.ts apps/clankie/test/fleet-refresh.integration.test.ts --reporter=default --reporter=json --outputFile=.local/subagents-proof/tests.json
/Users/james/.herdr-handoffs/clankie-backlog-20261003/bin/heavy pnpm --workspace-concurrency=1 --filter @clankie/protocol --filter @clankie/clankie typecheck
pnpm exec oxlint --deny-warnings packages/agent-transcript/src/subagents.ts packages/protocol/src/operator-conversations.ts packages/protocol/src/operator-service.ts apps/clankie/src/agent-sessions.ts apps/clankie/src/captain/seat-subagents.ts apps/clankie/src/captain/presence.ts apps/clankie/src/captain/captain-operator-service.ts apps/clankie/test/codex-subagents.test.ts apps/clankie/test/subagent-native-history.integration.test.ts apps/clankie/test/seat-subagents.test.ts apps/clankie/test/captain-native-subagents.test.ts apps/clankie/test/fleet-refresh.integration.test.ts
```

Each command exited 0. Vitest 4.1.10 reported 7.28 seconds for the focused run.
The corresponding files are `install.log`, `tests.log`, `tests.json`,
`typecheck.log` and `lint.log` under the ignored evidence directory.

| Test file under `apps/clankie/test/`          | Passed | Exercised behavior                                                                                                                                         |
| --------------------------------------------- | -----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex-subagents.test.ts`                     |     17 | Direct-child identity, labels/times, completion and restart, targeted status versus untargeted waits, idleness, cache invalidation and cross-day discovery |
| `seat-subagents.test.ts`                      |      5 | Claude foreground/background settlement, native identity/times, bounded labels and addressed local-seat filtering                                          |
| `subagent-native-history.integration.test.ts` |      4 | Native Claude/Codex JSONL and registered OpenCode SQLite child pages, cursor/reset behavior, exact parent relation and escaped-path refusal                |
| `captain-native-subagents.test.ts`            |      2 | Selected captain's child count, presence/schema projection and completion/replacement notifications independently of worker-seat count                     |
| `fleet-refresh.integration.test.ts`           |      2 | Public captain fleet/roster requests share a refresh; mutations force a fresh census; addressed-seat readers share real filesystem discovery               |

The filesystem fixture recorded 10 seats, 16 concurrent callers and 1,024
unrelated directories. Cold reads used 5,390 stats, 1,069 directory operations,
1,064 opens (20 parent opens) and zero synchronous walks. Warm reads used 110
stats, **zero directory operations, opens, parent opens or synchronous walks**.
These are fixture operation counts, not a live-service CPU/latency benchmark.

## What this establishes

The requested native-core slice already exists. The checks exercise real
temporary native journal files and SQLite databases, production transcript
readers, schema validation and cursor/path boundaries. Fleet integration uses
controlled census/proof dependencies; it does not create or hire native agents.
Existing goldens describe native formats, rather than fresh harness sessions.

Source inspection also confirms the `subagent_replay` dispatch in
[`captain-operator-service.ts`](../../../apps/clankie/src/captain/captain-operator-service.ts):
it requires an existing seat/persona parent conversation, rejects remote seats
and changed parents, and returns normalized read-only pages without a new child
conversation or send/resume/control authority. The selected five-file run
exercises `AgentSessions.readSubagent` and public fleet/roster calls; it does
**not** provide a new end-to-end HTTP/device proof of that replay operation.

Existing behavior and limits remain documented in
[ADR 0208](../../adr/0208-agents-carry-a-role-the-world-reads-it.md): bounded
discovery, unknown counts for unreadable/unaddressed/remote seats, heuristic
Codex idleness, and native child identity rather than labels or list positions.

## Limits and closure decision

- No `clankie-app` source was read or changed, and no fresh app visual or
  device proof was produced. Prior VUH-1532/1533 attachments remain historical
  evidence for the lead to assess separately.
- No explicit CLI child selector was found in the current command registry or
  fleet command. The replay contract is API-first; this check does not claim
  a new CLI selection flow.
- Selected Codex child replay still calls the synchronous native-child resolver
  and file reads in `packages/agent-transcript/src/subagents.ts`. Its latency,
  CPU and discovery cost were **not measured** here. The zero synchronous-walk
  result above applies to roster projection, not selected-child replay.
- No model calls, live hiring, owner runtime, AWS, simulator or external write
  occurred. No new production fix was needed for this scoped core verification.

The assigned core discovery/lifecycle/reader portion is complete at the stated
base. Linear's app children VUH-1532 and VUH-1533 are already Done and retain
their prior device/transcript evidence. Closing this scoped ticket does not
claim fresh visual acceptance of James's ongoing app redesign. The CLI and
selected-history performance limits above are outside this verification.
