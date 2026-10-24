# ADR 0290: App switch metrics are bounded device reports

Status: accepted, 2026-10-24. VUH-2558.

## Decision

Release clients report navigation timing through an authenticated paired-device
POST. The service derives the device ID from the current device session; the
body contains only a closed platform and destination vocabulary, timing
percentiles, sample counts and slow-switch counts. It rejects unknown fields.
The operator reads the result with `clankie metrics --app`.

The app computes nearest-rank p50/p95 over its latest 64 successful switches per
destination. Each report is a complete snapshot of that device/platform's
rolling windows. The service replaces the previous snapshot; percentiles cannot
be averaged into meaningful combined percentiles. Different device/platform
windows remain separate.

The service retains at most 64 device/platform snapshots, each with at most eight
destinations. It rejects reports larger than 4 KiB, limits accepted updates to
one per second per device/platform, expires inactive snapshots after one hour,
and excludes revoked/expired automation devices. No journal, device name, user
content, URL, project, or credential is recorded. Restarting the service resets
these ephemeral diagnostics. Authentication, rather than payload data, decides
which device owns each window.

`slowCount > 0` is the metric warning flag for first-frame time over 100 ms.
Unsupported long-task observation is `null`, not zero. These are app-reported
measurements, not trusted accounting, a profiler, a CI gate, or a cross-device
population percentile.

## Why

View-switch lag previously depended on someone noticing and profiling it by
hand. Gateway diagnostic logs do not expose per-device rolling timings beside
the service's existing metrics. Fixed schemas and ephemeral caps make this
always-on path useful without creating content telemetry or unbounded history.
