# VUH-1962 — built-in tracker sync proof

Implementation: `0069a7c91ba8de4ca6e48e81d90c520d3036b409`. Sync 1 server only; no deployment or app object pool.

Five integration cases pass against the real journal, evidence store, signed
device pairing, HTTP host and HTTP relay:

- project JSON-lines bootstrap/count/cursor, partial bootstrap and lazy batch hydration;
- two clients receiving the same ordered commit, disconnect and cursor resume;
- keyed replay returning the original outcome without another journal write;
- atomic refusal, stale preconditions, key conflicts, project moves and durable replay;
- stage/evidence/independent-check fences per transaction operation, and device revocation.

The separate scratch command paired two independent clients with a disposable
local service and relay. A's create reached both clients at sync ID 2. B then
disconnected and edited; A saw sync ID 3, and B recovered that same commit.
Keyed replay returned the original response. Both temporary servers and their
scratch files were removed. Clankie's conversational model was not exercised.

Commands (all run under `clankie heavy --`):

```sh
pnpm exec vitest run apps/clankie/test/tracker-sync.integration.test.ts
pnpm --filter @clankie/clankie exec tsx scripts/tracker-sync-roundtrip.ts
pnpm --workspace-concurrency=1 --filter @clankie/protocol --filter @clankie/work-items --filter @clankie/clankie --filter @clankie/relay --filter @clankie/tui typecheck
```

All exited 0. `proof.log` retains the inspected outputs and exact implementation
diff. The landing gate is recorded separately in `.local/landing-gate.json` and
`.local/landing.log`; the issue's landing comment names its checked HEAD/base.

Gaps: no production deployment, load benchmark, app/offline queue, or real hosted
account transport was exercised. Milestones remain an empty model vocabulary
entry until the built-in tracker has milestone records. The proposed protocol
decision is in ADR 0226's VUH-1962 amendment.
