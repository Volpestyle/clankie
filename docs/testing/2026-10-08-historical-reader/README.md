# VUH-1866: historical preparation under the landing gate

[Issue](https://linear.app/vuhlp/issue/VUH-1866).

The failing case is `apps/clankie/test/lead-historical.test.ts`,
“actual gradeHistorical settlement never yields a passing result when its exact
verifier stop is unknown”. The handoff records 48.585 seconds under the broad
selection, exceeding its unchanged 30-second budget, versus 6.39 seconds alone.
The Docker boundary is a deterministic fixture; no Docker or model executes.

## Cause and repair

The measured bottleneck is repeated synchronous Git process launches during
historical preparation. The case starts 291 native commands, including 135
`rev-parse` and 111 `show` commands. Each provenance recheck launches processes
for the same pinned objects again. This work blocks the test's event loop and
makes its wall-clock deadline sensitive to process and filesystem contention.
The historical failure's exact competing workload was not recorded; no ordering
dependency or shared fixture-state corruption was demonstrated.

The reader now uses `git cat-file --batch` for each provenance recheck and for
the dependency-input read. It still reads fresh objects each time, checks the
parent, both trees, changed grader paths, blob IDs and SHA-256 digests, and
preserves exact binary bytes. There is no provenance cache. Source exports,
candidate Git indexes, protected paths, stop receipts, timeouts and worker
concurrency are unchanged.

## Quiet original/batch comparison

The same exact case and dependencies ran in original → batch → batch → original
order, inside one `clankie heavy` permit. No iOS compiler processes were visible;
resource pressure was healthy before and after every run. Load ratios declined
from 1.03 to 0.81. The [compact measurements](quiet-ab.json) retain the reader
hashes, case result, command counts, phase timings and pressure samples.

| Reader   | Case duration | Native commands | Native-command time |
| -------- | ------------- | --------------- | ------------------- |
| Original | 7.286 s       | 291             | 5.996 s             |
| Batch    | 4.395 s       | 79              | 3.268 s             |
| Batch    | 4.144 s       | 79              | 3.050 s             |
| Original | 6.960 s       | 291             | 5.780 s             |

The batch reader removes 212 launches per execution and reduces case time by
about 40%. The repeat original run restores the slower result, distinguishing
the reader change from merely warming the fixture. This identifies avoidable
process-launch work as the repair point, rather than evidence that the timeout
budget itself is wrong. It does not prove the identity of the competitor in the
original failed run.

One retained broad trace overlapped the lead's Release iOS build. The target
passed in 7.154 seconds. That trace did not reproduce the timeout, and timings
from that build window are excluded from the causal comparison. A separate
four-copy probe passed all executions in 8.32–9.94 seconds; four forks alone did
not reproduce the original timeout.

## Other gate repairs

A native-room MCP fixture connected to an unrelated IPv4 web application while
its listener had no explicit hostname. It now binds `127.0.0.1`, matching its
client, and awaits the listening event before reading the assigned port. The
real MCP and native ancestry assertions remain in place.

A separate artifact-ignore commit covers only root `.tmp/` and
`dynamodb-local-metadata.json`. The former contains a scratch desktop-pet
presence proof whose script writes local proof/state files; the latter is
DynamoDB Local's installation/telemetry metadata. Existing files in the main
checkout were preserved. The ignore rules do not exempt arbitrary untracked
source from hire checkout validation.

## Evidence location and main verification

Raw reports and temporary instrumentation live in `.local/vuh-1866/` in the
assigned worktree. The original historical test is restored byte-for-byte;
no diagnostic instrumentation or duplicate probe is shipped. This record
covers the quiet comparison; the issue's landing evidence records the final
main SHA and three consecutive complete gate runs with the exact case selected.
