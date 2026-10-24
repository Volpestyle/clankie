# VUH-2792: stop re-parsing unchanged receipt journals

Scoped service reliability optimization, measured on core6d3b13d8543fc108fbaa9a99e1149ed027a03c80. No live service restart, signals, inspector enablement or state changes.

## Attribution

Live PID19424 still shows major GC, JSON string parsing and subprocess launches in a fresh10s native sample, consistent with the earlier20:44 sample. Native stacks do not identify their JavaScript callers. No inspector listener exists, the launcher disables SIGUSR1, and fs_usage requires root. No such boundaries were changed. A60s child census saw21SSH and19git launches; this does not assign all child CPU to the service or prove their callers. Spawn work is not fixed here.

A concrete repeated parse source is DurableReceiptStore.load: every operation reads and JSON/Zod-parses the entire connected-call or seat-call journal. The private fixed corpus contains15,779 connected receipts/8,763,740bytes and7,006 seat receipts/2,063,380bytes; connected receipts retain1,000result bodies with3,183,643content bytes. A private production-reader replay resolves its JS profile to load, Zod validation and GC. This identifies that reproduced caller, not its fraction of the live alarm.

## Change and boundaries

Cache one validated durable generation per journal, checking device/inode/size/nanosecondmtime/ctime on every access. A readonly lookup copies just the requested record. Mutation paths still load a private full map and invalidate validation before saving; durable admission, settlement, retention, authority checks and their ordering are unchanged. Missing/corrupt/changed files are never answered from an earlier validation. The in-memory path remains independent of filesystem caching.

JSON copies share immutable strings and recursively copy objects/arrays, following the existing settings-store approach. An exploratory whole-map structuredClone version reduced CPU but raised RSS to1.48GB, so it was rejected. A full-map JSON copy still raised short-run RSS; the submitted selected-record lookup avoids that work at its source. Those trials are not the final candidate measurements.

## Controlled private replay

The same frozen private journal copies are replayed without provider dispatch or external I/O. One process per arm, five warmup pairs, then200read pairs with10ms yields. Three alternating baseline/candidate runs; baseline substitutes only the four original production modules at their normal URLs. All other code, dependencies and bytes match. Process CPU is user+system delta (including V8 worker threads), not elapsed JS time or a percent of the live service. Profiles are enabled identically. Host contention is uncontrolled; these are process-local work comparisons, not fleet replay or statistical confidence.

| 200read pairs               | Baseline median | Candidate median |
| --------------------------- | --------------: | ---------------: |
| Process CPU seconds         |       15.615539 |         0.057623 |
| Connected lookup elapsed ms |       31.369813 |         0.033938 |
| Seat lookup elapsed ms      |        6.679938 |         0.017333 |
| Natural RSS bytes after run |     514,161,752 |      355,504,152 |

Including warmups, journal reads fall206+205→1+1; read bytes2,228,323,340→10,827,120. This is a warm unchanged-journal best case, not a promise for a fleet continuously writing receipts.

A separate single mixed pair includes20writes across200read pairs: process CPU17.515400→1.919428seconds, natural RSS618,824,952→574,533,984bytes. Connected journal content reads226→20; seat reads205→1. Final persisted connected-journal SHA256 matches in both arms: d9331b017b430cb2d743de93770428dbbfd4143d6c0fa338e1ff476ccee0cabc.

Private post-run heap snapshots total186,254,048→185,604,415self bytes. These are whole private-process snapshot totals, not retained-owner attribution, a live heap snapshot or an explanation of the reported1.7GB heap. Raw snapshots and private input journals remain local under .local/vuh-2792; published summaries contain no receipt payloads.

## Regression and remaining proof

58tests across four real-filesystem/MCP/work-write files pass. Five new cases cover independent returned objects, independent writers, same-size restored-mtime edits, atomic replacement, corruption/deletion/recovery and counted real filesystem reads. A subprocess uses the public seat-receipt API and real filesystem:10same-generation lookups read journal bytes10times on baseline versus once on candidate, with identical results. Existing real HTTP MCP and work-write journeys cover durable admission/reconciliation/abandonment/retention. Formatting passes. Earlier package typecheck passed before the final selected-record refinement; final root landing gate is reported separately.

VUH-2792 remains incomplete: no live JS-level caller profile or live heap snapshot, no unique attribution of the whole alarm, and no comparable8+seat30-minute after-deployment CPU/RSS window. A passive baseline monitor records PID19424 independently; no installation or restart was performed. VUH-2776's remaining whole-app CPU work is deferred to the lead's later assignment.
