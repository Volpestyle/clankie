# VUH-2803 — decode each native telemetry append once

[Published proof archive](clankie://evidence/sha256/fe71e8764f869dddeb3fc64c4130eb738023801505d534864a411e4c151c6179).

Before this change, every append to a native Codex or Claude transcript made seat
telemetry re-read the whole 2 MiB tail, decode it, serialize the records again, and
decode them a second time for the report projection. The activity projection then
serialized a suffix again. On a real 51.9 MB Codex rollout, 40 small appends cost
about 1.1 CPU-seconds, almost all of it in `nativeSnapshot`. The agent-transcript
display tail was already incremental and cost about 3 ms for the same 40 appends.

## Behavior

`seat-telemetry.ts` keeps the complete lines of each native file's last 2 MiB,
decoded with their byte offsets, for at most 16 files. An append decodes only the
bytes after the last complete line, drops lines that fell out of the window, and
projects the window from the retained records with `herdrSeatTranscriptEntries`.
That is the projection `parseHerdrSeatTranscript` already applies to text, so
nothing is serialized and decoded again.

The window, the filtering, the session/sidechain boundaries, the unchanged-stamp
snapshot cache, shared in-flight reads and the before/after `fstat` fence are
unchanged. An unterminated final line counts only if it parses, as before. It is
never kept, so it is decoded again once the writer finishes it. The file is read
whole again unless all of these hold: same device and inode, strictly larger size,
an identical first 64 KiB, and an identical 4 KiB before the last decoded line.
Truncation, a same-size rewrite in place, replacement, and a rewritten session
header therefore each read the file whole. A concurrent read stores its tail only if
no other read replaced the cached tail first. Results are frozen as before, and the
retained records never leave the module.

## Verification

All runs below are private replays on this worker's copies of real recorded
transcripts; the input SHA-256s are in `inputs/`. Baseline is the source at
`0fe7ff64`, run from a checkout at that commit. The source hashes and the diff are
in `source/`.

- **Real append parity, 992 steps, 0 mismatches.** `scripts/parity.mjs` loads the
  baseline and candidate modules side by side. It replays the last 4 MiB of each
  of five real transcripts (three Codex, two Claude, 8 to 64 MB) as seeded random
  appends that cut lines anywhere, from 1 B to 96 KiB. After each append it
  compares `readSeatTelemetry` and `readSeatActivity` byte for byte. Each replay
  also injects a malformed line, a truncation of 512 KiB, a same-size touch, a
  same-size rewrite and restore, and a rename replacement. Coverage: model on 724
  steps, Codex context on 611, Claude report success on 110, failure identities
  on 131, Claude activity on 23.
- **Codex report and activity facts did not occur in any real rollout.** Current
  Codex wraps MCP and shell calls in its `exec` tool, so neither baseline nor
  candidate observes a Codex `message_clankie` call or a mapped tool kind. This
  existed before the change. The committed test covers interleaved Codex calls
  with synthetic records.
- **Committed integration test.** It is in `apps/clankie/test/seat-efficiency.integration.test.ts`.
  After each append, partial line, malformed line, truncation, same-size rewrite,
  rewrite plus growth, replacement, session-header rewrite and Claude
  sidechain/foreign-session line, it compares the incremental read with a cold
  read of a copy of the same bytes. It also asserts the expected values.
  `mutations.log` shows the test failing when any one of the four continuation
  fences is removed (window trim, header, strict growth, end anchor).
- 153 tests pass across the 12 telemetry, transcript, watch, TUI and relay files
  (`focused.log`). The `apps/clankie` and `agent-transcript` typechecks pass.

## Cost

These are the VUH-2792 phases on the same 51,901,669-byte Codex corpus. The cold
read is the agent-transcript reader. `unchanged40` is 40 telemetry and activity
reads, the first of them cold. `appends40` appends 40 token-count lines and runs
telemetry, activity and the transcript reader after each. The output hashes are
identical in every run (`6211334761d9…`).

| Uninstrumented process CPU, median of 3 alternating runs | Baseline | Candidate |
| -------------------------------------------------------- | -------: | --------: |
| `appends40`                                              |  1.115 s |   0.244 s |
| `unchanged40` (includes the first, cold telemetry read)  |  0.025 s |   0.013 s |
| cold transcript read (unchanged code)                    |  0.336 s |   0.341 s |

| `appends40`, separately instrumented run |     Baseline |  Candidate |
| ---------------------------------------- | -----------: | ---------: |
| `JSON.parse` calls                       |       96,576 |         80 |
| bytes given to `JSON.parse`              |     285.9 MB |    13.6 KB |
| GC pauses, median of 3 (count / total)   | 27 / 11.9 ms | 3 / 1.4 ms |

The parse-counting hook and the GC observer run separately from the CPU runs. The
remaining candidate cost per append is mostly redaction (`cleanDetail`) in the
report projection of the window (`profiles/candidate-selftime.txt`). It runs again
for each generation because the projection's tool-name and dedupe state depends on
where the window starts.

## Retention

This trades decoding work for retained heap. With `--expose-gc`, after the 40
appends, the candidate holds 132.4 MB of JS heap against the baseline's 124.6 MB:
7.8 MB more for one seat whose 2 MiB window is mostly tool output. Right after the
first telemetry read the difference is 3.0 MB. The cap of 16 files bounds the worst
case at about 16 full windows, roughly 50 to 120 MB at this ratio. Those records are
long-lived old-generation objects for major-GC marking, in exchange for no longer
allocating about 7 MB of short-lived decoded records per seat append.

This is a replay of one hot seat, not a whole-service measurement. It does not show
how much of the live VUH-2792 CPU, GC or 1.2 GB heap this path accounts for. A
comparable after-deployment fleet measurement belongs to the lead. No live service
was touched, profiled or restarted. Raw transcripts stay local.
