# VUH-2827 / VUH-2817 Patch C1: connected-call receipt writes

The matched live 60-second window at 18:18Z on 2026-10-25 observed 35.25 MB
of connected-call journal replacements (four changes), 21.91 MB of conversation
metadata replacements (two changes), and 3.28 MB of seat-efficiency writes.
Together, observed writes accounted for 60.44 MB of the process's 64.42 MB
logical writes. These are 20ms polling observations, not exact invocation
counts: rapid changes can be missed. CPU was 40.45%; load rose 7.46 → 7.77.
The larger earlier 813 MB/min window is not attributed entirely to metadata.

The connected-call ledger held 16,452 receipts in 8,909,873 bytes when frozen
privately for replay. Every save serialized and replaced that entire file;
its next generation had to be parsed and validated again. Patch C1 opts only
this journal into 256 immutable buckets behind one atomic manifest. Random
UUID prefixes distribute receipts. Only changed buckets are serialized, synced
and replaced. The manifest commits after the new shards are synced; obsolete
previously committed shards are removed afterward. Failed/crashed preparations
remain unreferenced, never admitted calls. Unchanged saves preserve the root.

Reads accept the legacy array and migrate on the next save. Cached reads check
root identity and the selected shard's identity; full loads check all committed
shards. Changed content is hash- and schema-validated. Missing/corrupt committed
shards fail closed. Callers receive detached records. All uncertain calls and
identity tombstones remain; the existing 1,000 settled-result-body policy and
READ proof trimming are preserved. No cached receipt supplies fresh authority.
Other journals retain their flat format. Conversation metadata is Patch C2.

## Matched retained-data replay

The actual private ledger is copied into a disposable directory for each arm.
Both use production `DurableReceiptStore`, real filesystem I/O and the same
schema/input/cadence. A Node load hook substitutes the unchanged base store at
its normal module URL for the original arm. The replay schema validates core
receipt fields and preserves other fields; the service's stricter full worker
schema is exercised separately by the real-provider integration suite.
Migration/warmup precedes measurement. Sixty updates occur at 500ms intervals,
with three public receipt reads per update. Passthrough filesystem counters
count actual write bytes and fsync calls. No I/O is stubbed and no GC is forced.

| Measurement        |      Original |      Patch C1 |
| ------------------ | ------------: | ------------: |
| Elapsed seconds    |       30.0001 |       30.0014 |
| CPU seconds        |      3.665683 |      1.776301 |
| Process CPU        |       12.219% |        5.921% |
| Natural RSS at end | 356,542,288 B | 170,351,704 B |
| Actual write bytes | 534,629,174 B |   3,442,155 B |
| Writes             |            60 |           120 |
| fsync calls        |             0 |           240 |
| Root size at end   |   8,911,076 B |      20,524 B |

Write bytes fall **99.36%**, despite adding durable file/directory syncs.
This is one sequential pair on an uncontrolled shared host, not a confidence
interval or deployed whole-service result. The cadence stresses this component;
the observed quiet live window had four receipt rewrites per minute. It does
not attribute all live CPU to receipts. Lead owns deployment and live acceptance.

## Regression coverage

The real WorkerMcp → MCP host → SDK HTTP provider fixture proves:

- A legacy ledger over 8 MB migrates without losing 900 retained response bodies
  or an uncertain call. The next provider call changes one bucket; its committed
  byte footprint is under 1/20 of the legacy file. A redundant save preserves
  manifest inode and mtime.
- Recreating WorkerMcp preserves successful and uncertain reconciliation and
  deduplication with no repeated provider effect.
- A separate real Node process fails before the manifest rename, leaving only
  unreferenced preparations; another dies at the rename boundary. Recovery sees
  only committed admissions and refuses to redispatch the uncertain one.
- Changed or missing committed shards refuse dispatch even with warmed caches;
  restoring the shard recovers the original receipt without another effect.
- Existing authorization, native identity, scoped READ recovery, retention,
  cancellation, deadlines and late-settlement tests remain intact.

Three focused suites pass 51 tests. Root gate and exact-patch Sage approval are
required separately before landing. All commands use `clankie heavy --`.
Original receipt bodies stay private; the archive contains only scripts,
content-free measurements and synthetic fixture sources.

[Measurement scripts, summaries and regression evidence](proof.json).
