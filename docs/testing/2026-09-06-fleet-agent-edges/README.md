# Agent-to-agent edges, proved from a real Herdr to a real fleet snapshot

Date: 2026-09-06 America/Chicago

Scope: the whole VUH-1210 → VUH-1212 chain, end to end, with no fixtures between the two ends. A real Herdr
built from the release pin emits the events; the captain's own shipped modules read them; the snapshot that
comes out is validated against `OperatorFleetSnapshotSchema`. Verifies ADR 0163 and the acceptance criteria
of [VUH-1212](https://linear.app/vuhlp/issue/VUH-1212).

Code: Clankie `cbe18ae4` (main), which carries the fleet-edge work `9e0c1097` and the Herdr pin move.
Herdr `0e1bcb93d836a61eac6dbd3b0089e487e95e66ac`, built by `pnpm herdr:build` from
`scripts/release/herdr.json` — so the binary under test is the one a release bundles, not a developer build.
The pinned tarball's `sha256` was fetched twice and was byte-identical both times.

Real, and load-bearing: the Herdr binary, its session socket, its event subscription, two live Claude Code
agents with their own harness sessions, `herdr agent list`, and the captain's `watchHerdrFleetChanges`,
`readFleet`, `PromptEdgeWindow`, `parentSeatIds` and `deriveFleetEdges` imported directly from `main`.

Substituted, explicitly and only:

- **The captain service was not booted.** Its `fleet` operation sits behind the authenticated operator
  dispatch (device pairing), so the probe drives the same fleet path in-process and assembles the snapshot
  the way `fleetSnapshot()` does. `personas` and `channels` are empty because their stores were not started;
  neither is touched by this change. Every line of the edge derivation is the shipped code.
- **The sender's pane id was supplied as an environment variable** rather than by running the CLI from inside
  a Claude agent's own Bash tool. `HERDR_PANE_ID=w5:p2 herdr agent prompt beta …` is byte-for-byte the
  environment a pane-resident caller has, and the note proves separately that Herdr really injects it: a
  shell in pane `w5:p1` printed `INJECTED=w5:p1`.

An isolated Herdr session (`vuh1212`) was used throughout; the operator's live session was never a target.
It was stopped and deleted afterwards.

## The run

| Step    | What happened                                                                                         |
| ------- | ----------------------------------------------------------------------------------------------------- |
| Build   | `pnpm herdr:build` verified the pinned tarball checksum and compiled `0e1bcb93`                       |
| Session | scratch session `vuh1212` started on that binary, on its own socket                                   |
| Seats   | `alpha` in pane `w5:p2` and `beta` in pane `w5:p3`, both Claude Code, both with real harness sessions |
| Spawn   | `beta` started with `HERDR_PANE_ID=w5:p2`, so Herdr recorded `parent_pane_id: w5:p2` on the child     |
| Prompt  | `beta` prompted with `HERDR_PANE_ID=w5:p2`, so Herdr stamped `from_pane_id: w5:p2`                    |
| Read    | the probe derived a snapshot and parsed it with the wire schema                                       |

## What it proves

| Criterion                           | Evidence                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Herdr emits a prompt edge           | `{"event":"agent_prompted","data":{"from_pane_id":"w5:p2","to_pane_id":"w5:p3","timestamp_ms":1788739614864}}` on the socket |
| Herdr emits a spawn edge            | `{"event":"agent_spawned","data":{"parent_pane_id":"w5:p2","child_pane_id":"w5:p3",…}}`                                      |
| `parent_pane_id` reaches the census | `censusPaneJoin` carries `{seatId: term_65ad960027fd44, paneId: w5:p3, parentPaneId: w5:p2}`                                 |
| The captain records the prompt      | `CAPTAIN RECORDED {"fromPaneId":"w5:p2","toPaneId":"w5:p3","at":1788739614864}` — the window's own callback                  |
| The cursor advances on both         | the clock ticked 9 times across the run; the snapshot's cursor is `…:10`                                                     |
| Edges reach the snapshot by seat id | a `prompt` and a `spawn` edge, both `term_65ad959f423963` → `term_65ad960027fd44`                                            |
| The seat states its parent          | `beta` carries `parentSeatId: term_65ad959f423963`                                                                           |
| The wire accepts it                 | `OperatorFleetSnapshotSchema.parse` returned the snapshot unchanged                                                          |

### The drop rule proved itself

`alpha` was started from the operator's _live_ session, so Herdr recorded its parent as `w1Z:p7` — a real
pane that holds no seat in this roster. The census carries that `parentPaneId`, and the derivation produced
**no** spawn edge for `alpha` and **no** `parentSeatId` on it. That is the "drops when either end leaves the
roster" criterion happening on its own with real data, rather than a case a test had to construct.

## Evidence

- `evidence/herdr-wire-frames.log` — the raw socket frames, plus the captain's recorded edge
- `evidence/derived-snapshot.json` — the schema-validated snapshot, with the census join it came from
- `evidence/fleet-probe.ts.txt` — the probe; kept with a `.txt` suffix so the repo's own dead-code gate
  does not read an archived artifact as project source. Re-runnable once copied back to a `.ts` path
- `evidence/herdr-build.log` — the pinned build's tail

## Re-running it

```bash
pnpm herdr:build
.data/herdr/bin/herdr --session <scratch>          # needs a sized pty and a non-nested env
export HERDR_SOCKET_PATH=~/.config/herdr/sessions/<scratch>/herdr.sock
cp docs/testing/2026-09-06-fleet-agent-edges/evidence/fleet-probe.ts.txt apps/clankie/fleet-probe.ts
cd apps/clankie && npx tsx fleet-probe.ts raw.log snapshot.json 60
```

Two environment notes cost real time here: launching Herdr from inside a Herdr pane trips the nested guard
(clear the `HERDR_*` variables for the child), and a pty with no size makes `pane split` fail with
`ghostty error -2` (allocate one with `script` plus an explicit `stty rows/cols`).
