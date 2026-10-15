# VUH-2216: retained heap on the idle runtime

Live, read-only attribution on runtime PID 990 (`194da072f`, started 11:03Z),
2026-10-15 12:10–12:40Z, fleet idle. Attached through the inspector (SIGUSR1),
using V8's sampling heap profiler (64 KiB interval) and a 5-minute CPU profile
(1 ms). No heap snapshot of the live process was taken. The inspector was closed
afterwards (`process._debugEnd`). One `Runtime.queryObjects` probe at 12:32:15Z
paused the process for about 14 s and found nothing. Later RSS readings may
include its effect.

## Files

Raw files are in the evidence store (see `evidence.json`):

- `live/heap-{10,20,30}m.json`: sampling heap profiles (live objects allocated
  since 12:10Z), loadable in Chrome DevTools' Memory panel.
- `live/live.cpuprofile`: main-thread CPU, 12:10–12:15Z.

The attach script, summarizers and standalone SDK repro used here were
scratch tools and are not kept in the repository.

## Result

- Retained growth is linear: 145 → 285 → 414 MB sampled live at 10/20/30 min
  (~13.5 MB/min). `heapUsed` went 1.49 → 1.87 GB over the same window.
- 77% (320 MB) of it was allocated under the HTTP request → `LocalFleetLink` →
  `WorkerMcp.fleetRequest` → MCP SDK `handlePostRequest` path. The shapes are
  whole request graphs: http parser, socket Duplex, request-body
  ReadableStreams, undici Requests and headers, AbortControllers.
- The holder is `webStandardStreamableHttp.js:476`: JSON-response mode's
  `_streamMapping.set(streamId, { resolveJson, cleanup })`. `send()` resolves
  `resolveJson` but never runs `cleanup`, so each answered POST's entry, and
  through its closure the request's `authInfo.extra.authority` (admission
  closures over the local fleet identity, socket and request signal), lives as
  long as the session. Worker sessions slide their 15 min expiry on every
  request, so for a parked bridge that is forever. This is upstream
  modelcontextprotocol/typescript-sdk#2559, still present in 1.32.1.
- CPU: the main thread was 17% busy (52 s of 300 s). GC was the largest
  self-time entry (8.5 s). Process CPU is ~28 CPU-s/min, so most of it is
  off-thread, consistent with GC marking a growing live heap.
- Standalone repro (scratch script on the SDK transport): 1000 `tools/list` calls on one
  JSON-mode session leave 1001 `_streamMapping` entries on 1.29.0, and 0 with
  the patch.
- Integration test (`worker-mcp-session-memory.integration.test.ts`): 1000
  calls through the real `LocalFleetLink` and `WorkerMcp`. Unpatched: all 1052
  request attributions stay reachable and the heap grows ~19.7 MB. Patched: 1
  stays reachable and the heap grows ~1.9 MB (JIT and fixture noise; snapshot
  diff shows no per-request objects once the request's 2 s deadline timers
  fire).

## Not established

- The remaining 23% of retained growth (for example
  `captain/conversation-journal.ts` at ~10 MB/30 min) is not attributed. Some of
  it may be bounded caches.
- External/ArrayBuffer memory swung between 270 and 690 MB without a trend.
- The deployed effect needs a post-deploy RSS/CPU sample at matched uptime.
