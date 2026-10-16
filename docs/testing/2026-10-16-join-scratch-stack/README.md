# `clankie join` through a real gateway on a scratch stack — VUH-1800

Tracks: [VUH-1800](https://linear.app/vuhlp/issue/VUH-1800). Based on `origin/main`
at `956f351eb`. Contracts: [ADR 0212](../../adr/0212-machines-and-devices.md),
[ADR 0244](../../adr/0244-machines-join-clankie-at-an-access-level.md),
[CLI join](../../cli.md#join).

## Outcome

- The public join path works end to end across separate processes: a
  self-hosted home, a local gateway and simulated joining machines.
- **Two defects were found on the real path and fixed.**
  - A home restart ended every joined machine's `clankie join` (exit 1 after
    about 3 seconds), leaving it unreachable until someone ran `join resume`.
    The channel now reconnects with backoff.
  - A joined seat refused by its machine's level surfaced as the transport error
    `join_channel_unavailable` and recorded no owner observation. It now names
    the machine, its level and the level required, inside the encrypted response.
- **Not proven here:**
  - real Mac and Windows hosts;
  - a hosted (fleet-signed) body, which only the clankie-ops in-process fixture
    covers;
  - the deployed production gateway.

## Stack

All processes run on loopback, with no production gateway, AWS, Cognito or live
state. Each long-lived process runs under `clankie heavy --server`.

| Process          | What ran                                                                                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gateway          | clankie-ops `apps/gateway/src/index.ts` at `a09553a`, with one scratch static host token (`CLANKIE_GATEWAY_HOST_TOKENS_JSON`); no account config, push or fleet                                                  |
| Home             | the actual `apps/clankie` entrypoint from `scripts/scratch-stack.mjs`, bound with `clankie gateway set --url http://127.0.0.1:GW --host-id …` and the host token in its scratch file broker; doorway `connected` |
| Machines B, C, D | separate scratch HOME, state and credential files, each running the real `clankie join … --json` CLI through the gateway origin `http://127.0.0.1:GW/h/HOST`                                                     |

## Join, use, lower, leave, remove (26/26)

Machines B and C on the final code (run 3; runs 1 and 2 also passed 24/24 and 26/26 on earlier revisions). Values are from the run; codes and tokens
are never printed.

| Check                                                                                              | Result                                                                                                        |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `join` prints a local approval code; an unapproved join is not a machine                           | pass                                                                                                          |
| An unknown code is refused; the owner approves at `workers` with the advertised directory          | `join-02ae1d8c…`, `workers`                                                                                   |
| A used code cannot be replayed to widen access                                                     | refused                                                                                                       |
| `machines --json`                                                                                  | `transport: join`, `state: available`, `accessLevel: workers`, `accessEnforcement: joined-host`               |
| `join status` on B                                                                                 | configured, same machine ID, gateway origin; no secrets                                                       |
| `clankie claude --dry-run` from B's approved folder                                                | a full launch plan round-trips through the gateway inside the join envelope                                   |
| The same from outside the folder                                                                   | `directory_refused` (local)                                                                                   |
| Lower to `portal`, then a seat launch                                                              | `Machine join-… has portal access; this request requires workers. An owner can change its level in Machines.` |
| Raise above the approved ceiling                                                                   | `Rejoin with owner approval to raise this machine's access ceiling`                                           |
| Restore `workers`; interrupt `join`                                                                | registration kept                                                                                             |
| `join resume`                                                                                      | `joined` again; `state: available`; seat round-trip works                                                     |
| `join leave`                                                                                       | machine removed; later `resume` refused                                                                       |
| C joins, then the owner runs `machines remove` while C is connected                                | C's running `join` prints `finished: revoked`; later `resume` refused                                         |
| Approval codes and the host token in the gateway, service and relay logs, join ledger and settings | 0 occurrences                                                                                                 |

## Home restart (machine D)

D ran `join resume --json` while the home was stopped for about 30 seconds,
then started again:

```
02:42:41.605Z stdout {"event":"joined","machineId":"join-2d906da4-…"}
02:42:44.606Z stderr Clankie is unreachable; reconnecting.
          (gateway answers 503 for the host while the home is down)
02:43:15.895Z stderr Reconnected to Clankie.
          (clankie claude --dry-run from D: exit 0; home lists D available/workers)
02:43:25.885Z stdout {"event":"finished","state":"revoked"}   ← owner ran machines remove
02:43:25.896Z exit 0
```

Before the fix, the same sequence ended D's `join` 2.9 seconds after the home
stopped, with exit 1 and "Join could not complete". After the restart, the
earlier revocations of B (leave) and C (remove) were still refused. D's live
join token appears 0 times in the gateway log, the four service logs, settings,
the join ledger and D's own output.

## Tests

- `machine-join.integration.test.ts` adds "a joined machine reconnects after its
  home restarts, and revocation still ends it". The real HTTP home is restarted
  on the same port from its durable ledger. The test fails on the old client
  with `ECONNREFUSED`.
- `joined-seats.integration.test.ts` now requires the named refusal at portal.
  It previously pinned `join_channel_unavailable`.
- The focused join suites pass 36/36: machine-join, joined-seats, joined-screen
  and public-gateway-connector.

## Review

An independent native review of both commits found no security regressions. It
confirmed four properties:

- no operation is executed twice;
- a revoked machine cannot operate;
- the challenge is consumed before the sealed refusal;
- revocation still maps to `revoked`.

Its findings were addressed before landing:

- Using the fenced `requireMachineAccess` read let an unrelated settings write
  close a live seat. The seat check now keeps the plain read and calls the
  shared `refuseMachineAccess` only to record and raise the refusal.
- A machine removed during the check read as `portal`. The registration is now
  re-checked before refusing, so it answers `revoked`.
- The docs said "only revocation ends it". They now say that leave, removal, a
  foreign identity or a duplicate request ends `join`. Transport, decryption,
  schema and home-side failures retry after one notice, including against a
  home that is gone for good.

Left as reported:

- Refusal observations for removed machines are never pruned. This predates the
  change; `joined-computer.ts` has the same behaviour.
- The home answers permanent and temporary channel errors with the same
  plaintext 403.

## Observed, not changed

No service path dispatches the `shell` operation kind to a joined machine. Only
tests call `joins.request({ kind: "shell" })`. Workers (VUH-2128) and screen
(VUH-1803) have product callers. A machine approved at `shell` therefore gains
nothing over `workers` until a captain tool uses it.
