# VUH-2803 — decode each native telemetry append once

[Published proof archive](clankie://evidence/sha256/55a8ddd83f47f2feb0510d9876bea8996a9fda453034e058d895c6e80c8111cf).

Before this change, every append to a native Codex or Claude transcript made seat
telemetry re-read the whole 2 MiB tail, decode it, serialize the records again, and
decode them a second time for the report projection. The activity projection then
serialized a suffix again. On a real 51.9 MB Codex rollout, 40 small appends cost
about 1.1 CPU-seconds, almost all of it in `nativeSnapshot`. The agent-transcript
display tail was already incremental and cost about 3 ms for the same 40 appends.

## Behavior

`seat-telemetry.ts` keeps the decoded complete lines of each native file's last
2 MiB, for at most 16 files. It projects that window from the retained records with
`herdrSeatTranscriptEntries`, the projection `parseHerdrSeatTranscript` already
applies to text, so nothing is serialized and decoded again.

The window, the filtering, the session/sidechain boundaries, the unchanged-stamp
snapshot cache, shared in-flight reads and the before/after `fstat` fence are
unchanged. An unterminated final line counts only if it parses, as before. It is
never kept, so it is decoded again once the writer finishes it.

Reuse follows one rule. Each read computes the cut a cold read would make (after
the first newline at or past `size - 2 MiB`, or 0 for a smaller file) from bytes it
reads now, starting at the earlier of that offset and the cached window. The
decoded lines are reused, and only the bytes after them decoded, if all of these
hold:

- the device and inode are the same, the first 64 KiB is unchanged, and the size grew;
- the cut equals the cached cut;
- the SHA-256 of every byte from the cut to the old decoded end is unchanged
  (malformed lines included).

Otherwise the tail is read cold. When an append moves the cut, that read is cold
and the next append continues from it.

Review found two earlier rules unsound, and the tests below now cover both cases.
Checking only the last 4 KiB before the decoded end missed an interior rewrite
followed by an append. A whole-window digest without recomputing the cut dropped
the first record of an untrimmed file, and it missed a rewrite before the window
that moved the cut.

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
- **Committed integration tests** in
  `apps/clankie/test/seat-efficiency.integration.test.ts`:
  - A randomized warm-versus-cold property test runs four seeds of 120 steps each,
    on files from one line up to 8 MB. Each op runs 18 to 35 times on files larger
    than 2 MiB. The ops: append (sometimes leaving a partial line), write a whole
    record that ends exactly at the cut or at another line end, edit a fact digit
    in place, change the header session, insert or delete bytes, and truncate.
    After every step, the reader on the live path must match a cold read of a copy
    of the same bytes. The test also asserts a first-line fact on a one-line file.
  - A scripted test covers truncation, a same-size rewrite, an interior rewrite
    plus growth, replacement, a session header outside the window, and Claude
    sidechain/foreign-session lines.
  - `mutations.log`: the suite fails on the first candidate (`67a7e7d8`), on the
    second (`a15fc8e0`), and on the second with only its zero-cut bug fixed (the
    skipped-prefix case). It also fails when any single rule is removed: cut
    equality, window digest, the zero cut for small files, or the header check.
- 154 tests pass across the 12 telemetry, transcript, watch, TUI and relay files
  (`focused.log`). The `apps/clankie` and `agent-transcript` typechecks pass.

## Cost

These are the VUH-2792 phases on the same 51,901,669-byte Codex corpus. The cold
read is the agent-transcript reader. `unchanged40` is 40 telemetry and activity
reads, the first of them cold. `appends40` appends 40 token-count lines and runs
telemetry, activity and the transcript reader after each. The output hashes are
identical in every run (`6211334761d9…`).

| Uninstrumented process CPU, median of 3 alternating runs | Baseline | Candidate |
| -------------------------------------------------------- | -------: | --------: |
| `appends40`                                              |  1.226 s |   0.328 s |
| `unchanged40` (includes the first, cold telemetry read)  |  0.027 s |   0.014 s |
| cold transcript read (unchanged code)                    |  0.355 s |   0.365 s |
| process RSS at exit                                      | 489.8 MB |  436.5 MB |

| `appends40`, separately instrumented run |     Baseline |  Candidate |
| ---------------------------------------- | -----------: | ---------: |
| `JSON.parse` calls                       |       96,576 |      3,727 |
| bytes given to `JSON.parse`              |     285.9 MB |    10.8 MB |
| GC pauses, median of 3 (count / total)   | 27 / 12.6 ms | 5 / 2.4 ms |

The parse-counting hook and the GC observer run separately from the CPU runs. The
candidate's parse count includes the cold reads taken when an append moved the
cut, which happened on a few of these 40 appends.
Each append rereads the decoded window and hashes it twice (about 0.7 ms per
2 MiB each). The rest of the candidate's cost per append is mostly redaction (`cleanDetail`) in the
report projection of the window (`profiles/candidate-selftime.txt`). It runs again
for each generation because the projection's tool-name and dedupe state depends on
where the window starts.

## Retention

This trades decoding work for retained heap. With `--expose-gc`, after the 40
appends, the candidate holds 132.2 MB of JS heap against the baseline's 124.6 MB:
7.6 MB more for one seat whose 2 MiB window is mostly tool output. Right after the
first telemetry read the difference is 2.8 MB. The cap of 16 files bounds the worst
case at about 16 full windows, roughly 50 to 120 MB at this ratio. Those records are
long-lived old-generation objects for major-GC marking, in exchange for no longer
allocating about 7 MB of short-lived decoded records per seat append.

This is a replay of one hot seat, not a whole-service measurement. It does not show
how much of the live VUH-2792 CPU, GC or 1.2 GB heap this path accounts for. A
comparable after-deployment fleet measurement belongs to the lead. No live service
was touched, profiled or restarted. Raw transcripts stay local.
