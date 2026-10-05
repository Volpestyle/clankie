# VUH-1676: goal ownership and enforced budgets

Candidate for Pell's integration, from `fix/vuh-1676` based on `origin/main`
`9a0589caa124264647a54eefa268174eb15a4f30`. This is isolated fixture evidence;
no goals were created against the live service, and no live service, accounts
or sign-ins were changed. No evals or full `pnpm check` ran.

## Result and decision

Native harness MCP `create_goal` now refuses with `native_goal_unsupported`,
including before the seat's channel registers. Owner activation/resume refuses
native conversations too. Queued and restored goals pause when the conversation
has a native head; ownership survives a disconnected channel or service restart.
An owner can retire that ownership by resetting the closed seat's conversation
or use a fresh Pi-owned conversation.

Pi model calls persist `proposed` goals without starting a loop. `/goal accept`
(owner API `accept_goal`) confirms one; owner `set_goal` can activate directly.
Pause/resume cannot turn a proposal active. Every service goal receives a finite
1,000,000-token default; explicit positive integer overrides remain available.
Legacy goals retain recorded usage and receive that budget before admission.

The provider stream accounts assistant responses, failures, retries and
compaction before further requests. Unusable usage stops the captured goal run.
Background cache warming is disabled during goal work. Queued prompts retain
their original goal identity, so replacement cannot inherit stale work or charges.

Refusal was selected because native delivery acknowledgment supplies neither
goal settlement nor token accounting. Forwarding continuations as wakes would
repeatedly enqueue them. Native Codex goal observations remain separate; this
change does not add a Claude/native budget bridge.

## Evidence

| Boundary                                   | Observable result                                                                                                                                                                                              | Coverage                                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Native MCP → real captain → disk           | Global and workspace seats refuse omitted and explicit budgets; no goal or Pi turn appears, including after restart.                                                                                           | [Native HTTP/MCP integration](../../../apps/clankie/test/native-goal-refusal.integration.test.ts) |
| Owner HTTP → protocol → store              | A persisted proposal remains inactive; only owner confirmation makes it active. An empty diagnostic poll leaves it active. Offline native ownership refuses activation/resume and pauses restored active work. | Same integration                                                                                  |
| Model → real Pi tools → disk               | `create_goal` persists an inert proposal; owner acceptance controls admission.                                                                                                                                 | [Real Pi integration](../../../apps/clankie/test/goal-execution-integration.test.ts)              |
| Real Pi provider/tool loop                 | The omitted/default budget stops the loop before another provider call; persisted usage equals response usage exactly once. Explicit budgets also stop work after model completion/blocking.                   | Same integration                                                                                  |
| Provider errors and compaction             | Failed responses retain usage; compaction spends the budget and cancels further work. Missing/malformed usage stops requests.                                                                                  | Same integration                                                                                  |
| Owner pause/replacement during preparation | Stale work cannot start or charge the replacement; pausing during request preparation admits no provider call.                                                                                                 | Same integration and [disk/queue coverage](../../../apps/clankie/test/autonomy.test.ts)           |
| Legacy persisted state                     | The 107,625,734-token unlimited legacy case becomes `budget_limited` before any run. A goal with remaining budget preserves usage and spends only that balance.                                                | Disk/queue coverage                                                                               |
| Console → owner command                    | `/goal accept` sends `accept_goal`; explicit budget and global autonomy controls keep their existing routes.                                                                                                   | [Console coverage](../../../apps/tui/test/shell-assembly.test.ts)                                 |

## Checks

- Focused Vitest batch: **65/65 passed across five files** (`autonomy`, native
  HTTP/MCP, real Pi execution, existing lane MCP, and console command coverage).
  The real Pi file contributes 18 tests; the native HTTP/MCP file contributes two.
- Typechecks: `@clankie/clankie`, `@clankie/protocol`, and `@clankie/tui` passed.
- Changed-path `oxlint --deny-warnings`, `oxfmt`, local Markdown links, retired
  claims, and `git diff --check` passed.
- `@clankie/docs check` fails on a pre-existing console extractor mismatch:
  registered `64`, extracted literals `62`, factories `1`. A source comparison
  against `origin/main` shows identical counts in both affected files:
  `commands.ts` `45/44`, `provider-commands.ts` `7/6`. This branch changes no
  command registration shape or count. Pell should retain this docs gate gap.

## Limits

One already admitted provider response or compaction can exceed the remaining
budget. Its actual usage is recorded, and subsequent requests are refused.
Live harness delivery was intentionally not exercised: the selected behavior
refuses service goal creation there. Landing and deployment remain Pell's work.
