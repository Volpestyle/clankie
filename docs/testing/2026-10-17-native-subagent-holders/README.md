# Native Claude subagents each get their own simulator holder, live (VUH-1888)

Tracks: [VUH-1888](https://linear.app/vuhlp/issue/VUH-1888), the open
criterion "each native subagent gets its own lease holder automatically".
The source change and its fixture checks are in the
[2026-10-08 evidence](../2026-10-08-simulator-holders/README.md) (`050aeba51`).

## What ran

- **Runtime:** the installed runtime and worker plugin at `cc2eb50e5`, which
  contains the fix (`clankie-worker` 0.6.17).
- **Seat:** a Claude Code seat, `term_65debb4028cbe7b`.
- **Pool:** free overnight; no app lease was present or touched.
- **Subagents:** two native Claude `Agent` subagents of that seat ran
  `clankie simulator acquire` for the same existing iPhone 17 Pro by UDID.
  Neither passed a `holderId`.
- **Receipts:** verbatim in [`live.txt`](live.txt).

## Result

|                             | Holder from the Bash hook          | Acquire                                                                      |
| --------------------------- | ---------------------------------- | ---------------------------------------------------------------------------- |
| Parent session              | `claude:e6f827b6…`                 | (none)                                                                       |
| Subagent A                  | `claude:e6f827b6…:agent:a831e73a…` | `acquired` lease `b0741452`, iPhone 17 Pro booted                            |
| Subagent B, while A held it | `claude:e6f827b6…:agent:ab32ca81…` | `waiting (simulator_capacity)`, position 1, naming A's holder as the blocker |

- **Distinct holders:** each subagent got its own holder with no
  `holderId` passed. B was queued for the exact device; it was not handed
  A's lease, which was the original failure.
- **Cleanup:**
  - B cancelled its ticket;
  - A, resumed, still carried the same holder and released its lease;
  - the pool was back to zero leases, and the device was shut down.

## Gap

**Codex `spawn_agent` children were not run live.** This seat is Claude Code,
and headless `codex exec` was ruled out, so the Codex half waits for a Codex
seat. That path takes `CODEX_THREAD_ID` over an inherited holder; it is
covered by the fixture checks in the 2026-10-08 evidence, not live.
