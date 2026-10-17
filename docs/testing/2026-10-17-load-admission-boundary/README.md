# VUH-2345: load fixture must preserve production's admission boundary

The load service used `localFleetProof`, whereas the production listener uses
`localFleetAdmissionProof`. Both perform the same native checks, but the older
factory returns `false` for unavailable observations. That made the load
fixture return a permanent membership refusal (403) for a temporary observation
failure. The bridge can stop polling after that response. Production instead
returns an explicit pre-dispatch `fleet_admission_unavailable` response (503),
which permits the shipped bridge's existing one retry.

The fixture now uses the production factory. No native scanner, proof budget,
transport timeout, bridge retry policy or release budget changed. This fixes a
proven load-fixture mismatch; it does not explain why the original kernel scan
exhausted its wall-clock budget.

## Real boundary regression

The existing real load-service child and controlled HTTP provider are retained.
No native proof or HTTP response is mocked. The service's configured Herdr
listener is genuinely absent:

- Invalid pane claims on the events (fleet proof) and peers (project proof)
  routes still return 403 and retain distinct correlated IPC diagnostics.
- A syntactically valid pane whose native observation is unavailable returns
  503, `Retry-After: 1` and `retryable: true`. No provider call is forwarded.

The new assertion **failed on main `6e188e797`**, receiving 403 instead of 503.
After aligning the factory, it **passed**, one test in 3.05 seconds:

```sh
clankie heavy -- pnpm exec vitest run \
  apps/clankie/test/fleet-load-diagnostics.integration.test.ts
```

The [retained red/green output](boundary-results.json) records both results.
Local originals: `.local/vuh-2345/admission-boundary-red.log` and
`admission-boundary-green.log`. The previously completed three default load
runs and diagnostic/profiling limits remain in the
[first evidence report](../2026-10-17-load-proof-diagnostics/README.md).

The extra post-fix default load run was cancelled while queued, before startup,
to prioritize landing this fix for the release candidate. Its cancellation is
not a load result. Tess owns the default load check on the final release tree;
that check and the underlying intermittent kernel stall remain open here.
Landing results and the final SHA are posted on VUH-2345.
