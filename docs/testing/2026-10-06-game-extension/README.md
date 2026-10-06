# Game extension contract — offline evidence

Candidate for [VUH-1616](https://linear.app/vuhlp/issue/VUH-1616) on
`wren/game-extension-contract`, based on `origin/main` at `72c1571a` plus Moss's
Pokémon robustness commit `8f4b19d1`. The lead owns integration and closure.
[ADR 0234](../../adr/0234-games-share-one-extension-contract.md) records the
boundary and remaining adoption work.

## Observed behavior

The new Pokémon integration test uses the installed native PokeAgents client,
a private file credential store and a real local Unix socket. Its world replies
come from the existing FireRed world-body specimen, and its metered mind emits
deterministic decisions and usage. No live world, paid provider, simulator,
Rivals desktop or eval runs were used.

- `status`/`health` do not open a connector. Host authority is checked before
  entry; a revoked guard issues no wire request. A disabled venue proves no
  join and confirms local termination without resolving a model.
- A 30-token session records two 15-token decisions, issues one action, reports
  budget exhaustion and leaves exactly once. The journal records all 30 tokens.
- A delayed decision allows exact-session stop and concurrent-start checks.
  A stale session stop changes nothing; a second start opens no second seat.
  The exact stop emits no action and confirms departure only after cleanup.
- A protocol-valid denied departure leaves the runtime `uncertain`, health
  `degraded`, and the host without a confirmed-stop receipt. Another start
  remains refused. Core's durable lease/recovery implementation is retained.

## Checks

All heavy commands used the fleet's `bin/heavy` wrapper. Dependencies were
installed in this worktree with `pnpm install --no-frozen-lockfile`; no dependency
or cache directory was linked to another checkout.

| Check                                                                                            | Result                         | Evidence                                             |
| ------------------------------------------------------------------------------------------------ | ------------------------------ | ---------------------------------------------------- |
| Pokémon extension IPC integration                                                                | 4 tests passed                 | [log](extension-tests.txt)                           |
| World body, play/voice, operation parity, room-event and Pokémon robustness regressions          | 71 tests passed across 6 files | [log](regressions.txt)                               |
| Play host/lease, Pokémon API controls/notables and Minecraft HTTP/body/voice fixture regressions | 36 tests passed across 5 files | [log](host-regressions.txt)                          |
| Core TypeScript                                                                                  | Passed                         | [log](core-typecheck.txt)                            |
| Game-extension and Pokémon TypeScript                                                            | Passed                         | [log](extensions-typecheck.txt)                      |
| Changed-source lint and formatting                                                               | Passed                         | [lint](lint.txt), [format](format.txt)               |
| Scoped package dead-code check                                                                   | Passed                         | [log](deadcode.txt)                                  |
| Local doc links and retired claims                                                               | Passed                         | [links](doc-links.txt), [claims](retired-claims.txt) |

The [source manifest](source-manifest.json) records the source/package inputs
for these checks. The final commit and evidence permalink are attached to the
existing ticket after push. Existing regression evidence applies to unchanged
inputs; the final contract edits were checked by the extension fixture and
TypeScript runs.

## Remaining work

Minecraft and Rivals implement their current flows independently. No Minecraft
implementation file changed here; its existing import of `roomEvent` stays
compatible. Native coordination to the Minecraft lead returned `undelivered`
(`No observed worker hook`); the request was relayed to Clankie. This migration
therefore leaves Minecraft adoption to its lead.

Installed-extension discovery and add/remove without core edits are not shipped
by this slice. Pokémon retains core authority entry tools and exact-session
restart recovery. The ADR maps each remaining gap for the lead to split and
close; this candidate does not complete all of VUH-1616's acceptance criteria.
Live gameplay and publishing behavior were not exercised.
