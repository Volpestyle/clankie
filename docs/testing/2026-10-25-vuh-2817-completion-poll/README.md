# VUH-2817 Patch D: bounded Codex completion observation

The production completion observer read every retained item every 500 ms for
each unresolved watch. Four frozen native histories contain 81 turns, including
one 78-turn history. The repeated full response, JSON decoding and unnecessary
item projection consumed measurable service CPU even after roster status moved
to metadata-only reads.

D polls retained turn IDs/statuses without items. A changed shape triggers one
fresh full-history response; unchanged shapes receive a full audit after 30
seconds. The initial observation always hydrates history, preserving completion
before watch admission. Full responses alone establish exact native turn ID or
queued userMessage.clientId identity, require one matching turn, and retain all
agent-message text with the existing 12,000-character tail.

Native summary pages retain only the first user input and last agent message.
They cannot establish queued-input identity or complete result text. Full pages
also have no common snapshot revision, so this patch preserves the baseline's
single full-response correlation boundary. Metadata is a read hint, never
cached completion authority. Late attribution or rollback with unchanged
IDs/statuses is caught by the periodic audit, with up to 30 seconds plus polling
and read time of additional observation latency.

## Matched production-reader replay

Two separate 65-second runs use identical frozen private native histories and
the production observer. A separate owned WebSocket provider serves original
full items or their item-free turn shells according to the real RPC parameters.
The baseline is the exact 20b892bb source, loaded at its original module URL.
The after arm includes initial hydration and two periodic reaudits per watcher.
No completion is fabricated: the target input is absent in both arms.

| Measurement / four watchers / 65 seconds |        Before |             D |
| ---------------------------------------- | ------------: | ------------: |
| Process CPU                              |       12.201% |        2.249% |
| Process CPU seconds                      |      7.931294 |      1.461632 |
| Response bytes                           | 3,014,485,644 |    79,031,871 |
| Full-history requests                    |           501 |            12 |
| Item-free metadata page requests         |             0 |           520 |
| Peak sampled RSS                         | 465,824,816 B | 224,885,064 B |
| Natural end RSS                          | 429,320,616 B | 193,805,696 B |

Response bytes fall 97.38% and process CPU 81.57%. Process CPU includes all
threads of the reader process; the separate provider and other fleet jobs are
excluded. RSS is sampled every 100 ms without forced GC or heap snapshots.
These sequential pairs ran on a shared Mac: they are component evidence, not
confidence intervals or a whole-service before/after.

V8 CPU profiles cover the same windows. The JSON message callback at
codex-app-server.ts:105 falls from 5.349% self / 5.830% inclusive wall time to
0.151% self / 0.176% inclusive. Main-thread GC falls from 0.473% to 0.094%;
idle rises from 92.207% to 98.903%. These sample proportions describe the main
thread, not all process CPU. Full profiles and inclusive/self aggregates are
archived with the scripts and content-free counters.

## Boundaries and verification

Metadata reads are sequential, with a 100-row page limit, 10,000-turn total,
10-second pagination budget, repeated-cursor and duplicate-turn rejection.
An in-flight RPC retains its 5-second timeout. Full history is limited to
10,000 turns. Cancellation and the current-seat authority guard bracket every
RPC. Invalid or unsupported native reads leave exact correlation unavailable;
the observer never resumes, sends, steers or answers an approval.

Three real transport suites pass 72 tests: external Codex completion/control,
remote private queue, and remote peer delivery. New regressions cover metadata
pagination without repeated full reads, later merged user inputs and all result
chunks, ambiguous identity across audits and recovery with unchanged metadata,
malformed/oversized/duplicate/cyclic pages, and authority loss during a full
read. Existing automatic-watch, fast-completion, cancellation and remote
authority controls remain.

The manual installed-native boundary proof runs against codex-cli 0.163.0 in
an owned credential-free home. It starts and persists one native turn,
explicitly interrupts that owned turn, and recovers the exact retained
completion through the production observer. An earlier setup raced native turn
startup and timed out waiting for a terminal state; the corrected setup passes.
No successful model-provider turn or eval, owner credential, live service
restart, signal, update or live tracker effect was used.

The full service source and 15 test-program typecheck also pass. Exact Sage
review and the root landing gate follow this packet. Deployment and live
whole-service CPU/RSS acceptance with the lead's current fleet remain separate.

Raw private histories and fleet metadata stay local. The archive contains
public source, bindings, sanitized profiles, test/typecheck logs and content-free
measurements only. See evidence.json for immutable archive links.
