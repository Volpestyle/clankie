# Views: a live heavy-queue board from a spec (VUH-2035)

Proof, 2026-10-10, that a view spec renders live fleet and tracker data and
follows the machine's real heavy queue as it moves.

## Isolated service (evidence/isolated-*)

**How it ran.** `flows/serve.mts` starts a throwaway instance of the real view
routes and store from the worktree, so the owner's running service was not
restarted. Both sources read that running service as the owner, read-only:
`GET /v1/operator/fleet-resources` (polled every 2 s, like the service's own
cache) and `POST /v1/work` `list`. The worktree's `clankie view` CLI drove it
with `CLANKIE_CONTROL_PLANE_URL=http://127.0.0.1:4399`. The harness ran from
`apps/clankie`, with its imports pointed at `./src/` so workspace packages resolve.

| Step          | What happened                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| create        | `clankie view create '<spec>'` stored `view_b3b65658e7f0`: temporary, `expiresAtMs - createdAtMs = 86400000` (24 h), not pinned. Both sources read `ok` on the first render (`isolated-create.json`).                    |
| before, 01:00 | Heavy capacity 4/8 in use, **14 waiting** (a busy landing hour), with 4 holders running and the Clankie Linear project's in-progress issues listed (`isolated-before.txt` / `.json`).                                    |
| after, 01:06  | Same view, with no spec change: **8/8 in use, 3 waiting**. The seats that had queued (`w47:p22`, `w47:p25`, `w47:p23`, …) now appear under Running, and the queue holds later arrivals (`isolated-after.txt` / `.json`). |

The automated proof is `apps/clankie/test/views.integration.test.ts`. It runs the
real CLI over real HTTP against the real store, a real resource governor with
two detached heavy holders, and the real work-items service. It covers create
(24 h default), the queue moving (holder released, waiter admitted), the owner
boundary (401 without a bearer), pin, unpin `--ttl 3d`, expire, and spec
validation.

## Live service

See the issue comment for the live proof on the deployed runtime.
