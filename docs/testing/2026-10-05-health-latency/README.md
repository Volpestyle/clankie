# VUH-1707: idle health latency investigation

The 493 ms p95 from the nondefault 30-second/one-second
[original canary proof](../2026-10-05-update-canary/README.md)
includes a delay in the installed Node client's idle keepalive scheduling. It
does not establish a 493 ms `/health` handler. Keep the 250 ms canary budget.

## Live runtime, read-only

The live process was on `8fcf47a54b578629386bdbc306db3ae2205d57f4`, PID 72655,
with 20 active fleet seats. Only public `/health`, CLI status, process statistics
and a three-second native `sample` were read. No live settings, deploys,
processes, simulators or credentials were changed.

| Client                               | Samples |        p50 |        p95 |    Maximum |
| ------------------------------------ | ------: | ---------: | ---------: | ---------: |
| Fresh curl                           |      30 |   1.406 ms |  13.396 ms |  17.351 ms |
| Node global fetch, keepalive         |      24 | 248.926 ms | 250.107 ms | 250.500 ms |
| Node global fetch, Connection: close |      24 |   1.386 ms |   5.100 ms | 249.777 ms |
| Native Node HTTP, keepalive          |      24 |   0.981 ms |   2.427 ms |   3.078 ms |
| Native Node HTTP, fresh              |      24 |   0.941 ms |   1.298 ms |   3.910 ms |

All requests returned HTTP 200 and the same runtime identity. Fetch/HTTP clients
waited 250 ms between requests; fresh curl probes also waited 250 ms. Raw client
records and nearest-rank summaries (the canary's p95 method) are in
[live-read-only.json](live-read-only.json). The native profile remains in the
owned worktree's ignored `.local/health-latency/`.

A separate two-second `top` sample observed about 15% of one CPU core for the
live process. This is an active fleet, not an idle baseline. The native stack
sample mostly showed poll and asynchronous filesystem completion work. It did
not show a synchronous half-second health handler.

James reported a memory exhaustion incident at 22:53. At 23:07 CDT, the host
still had 102 GB used, 26 GB unused, about 20.35 GB of swap used, and a one-minute
load average of 201.14. Host pressure can add latency; it does not explain the
repeatable client-specific scheduling delay by itself. Every subsequent heavy
step and owned runtime lifetime uses the fleet limiter.

## Identified transport cause

The installed executable is Node 26.7.0, with embedded Undici 8.9.0 and libuv
1.52.1. Its embedded Undici source SHA256 is
`11c5768e95725aaad435a18eee9811d0f35fb4fb012cd212e0899eb6b1d284b7`.
`scheduleIdleSocketValidation` schedules `setImmediate(...).unref()`; reused
idle HTTP/1 sockets cannot write until that validation callback runs. An idle
event loop can remain in poll until another timer or I/O event arrives.

This matches the upstream reproduction and root cause in
[Undici #5600](https://github.com/nodejs/undici/issues/5600) and the
[merged fix #5606](https://github.com/nodejs/undici/pull/5606), shipped in
[Undici 8.10.0](https://github.com/nodejs/undici/releases/tag/v8.10.0).
Both client and server enable TCP_NODELAY, excluding client Nagle as this cause.
The original trace attributed 491.815 ms of a 492.375 ms request to the time
before server arrival; server handling took 0.337 ms. A profiler and a 10 ms
event-loop histogram can wake the loop and hide the scheduling delay, so those
measurements alone cannot prove recovery.

The [owned native CPU profile](owned-profile.json) spent 37.828 of 41.855 seconds
in its idle leaf frame. Its other leading frames were module loading and source
compilation at startup. The full-service canary passed at 3.65% CPU and 6.21 ms
health p95 with those wakeups enabled; that result is explicitly excluded as
proof of a fix. The raw 1.69 MB profile is retained in ignored `.local/` with its
SHA256 recorded in the compact artifact.

Use a fresh native `node:http` connection for the infrequent local canary probe.
This avoids the shared fetch pool while retaining real TCP/HTTP, complete
response latency, the timeout, the 32 KiB response limit and exact runtime boot
identity. It does not alter the global dispatcher or add a background wakeup.

## Passive before-fix confirmation

The fleet-limited, unprofiled actual `index.ts` run reproduced a failed canary
with 0.728% mean CPU and 295.556 ms health p95 over 30.018 seconds/27 samples.
The same socket was reused. The slowest request took 445.790 ms:

| Phase                            |   Duration |
| -------------------------------- | ---------: |
| Request creation to headers sent | 445.095 ms |
| Headers sent to server arrival   |   0.214 ms |
| Server handler                   |   0.366 ms |
| Handler finish to body complete  |   0.116 ms |

Its event-loop accounting was 444.931 ms idle and 0.861 ms active. Another slow
request spent 294.647 ms before sending and 0.306 ms in the handler. Observations
were buffered until process exit; there was no profiler, histogram or observer
timer. Independent client comparisons ran outside the canary window. This
establishes the pre-send scheduling defect independently of synchronous trace
I/O and high runtime CPU. The hold remained in place. The diagnostic's healthy
assertion failed as expected; it is not healthy-passage or alert-receipt evidence.
See [before-fix-passive.json](before-fix-passive.json).

The code replaces only the local sampler transport. Real HTTP integration
checks cover fresh connections after idle, complete response timing, metadata
only requests, CPU identity, 302/503 refusal, the 32 KiB body bound, timeout
through body completion, and all four response boot identity fields. The
existing policy and real-child canary tests remain in the focused lane.

The first default-window attempt was interrupted by its status observer's
two-second fetch timeout after about 211 seconds. The last product result was
still pending and healthy: 21 samples, 0.500% mean CPU, 6.419 ms health p95.
Its 22 native health requests all used fresh sockets and took at most 18.106 ms.
[default-observer-abort.json](default-observer-abort.json) preserves the
incomplete result; it is not a product canary failure or a five-minute pass.
The harness observer now also uses bounded fresh native HTTP, preserving its
two-second GET/five-second POST timeouts and observation cadence. The exact
cause of that observer timeout was not traced independently.

## Separate CPU and alerting work

The observed live commit does not contain VUH-1699's
`68f6d6125d92189e261f11a74f181074f5f7a174`. That candidate reduces repeated native
proof work during peer-roster discovery; it does not change the health handler.
These observations do not establish whether its idle CPU fix works.

Oren's VUH-1702 candidate exists on his branch but was not in the fetched
`origin/main` or the observed live pin. A native alert receipt must be verified
after that integration; this investigation cannot claim delivery from an absent
hook. The managed collector's fetch transport also warrants review against its
own deployed Node version; the local Node reproduction does not prove an AWS
runtime regression.
