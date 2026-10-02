# One chronological contact sheet per persona video

[Work item VUH-1444](https://linear.app/vuhlp/issue/VUH-1444/owner-authored-persona-image-folders).
This supersedes separate frame injection; historical image and video evaluations
remain alongside this record.

Ten evenly spaced samples form a 5×2 contact sheet, read left to right and then
top to bottom. Each video counts as one image. Repetition stays in the sequence.
Tiles fit within 400×400; the sheet is at most 2000×800, with Pi compression and
further downscaling to 128 KiB base64. Eight references still fit within 1 MiB.
Exact vision-token charges are model-dependent and were not measured.

## Real recordings and status

Read the owner's two recordings in place, without copying originals or sheets
into the public repo. Both loaded as vibe references. The 29.712 s clip produced
a 1500×330 sheet (108,276 base64 bytes); the 13.317 s clip produced a 2000×442 sheet
(110,296 bytes). Total: **two references, twenty tiles, 218,572 base64 bytes**.
The preceding separate-frame run used six references and 346,992 base64 bytes.
This comparison describes the payload, not measured provider token usage.

Visually inspected the final cached sheets: both form two rows of five legible
tiles, showing the progression across each clip, with no added letterbox gaps.
The actual CLI set/status/clear commands ran with a temporary settings file.
[Retained CLI metadata](contact-sheet-cli.json) records two readable `sheetPath` files, grid dimensions and ten target
timestamps each. The files contain the exact processed pixels used in prompts.
Clear returned zero references; actual owner settings and source videos were
unchanged. No service restart or push.

The [live cached caption](contact-sheet-caption.json) leaves appearance
unspecified and recognizes temporal progression: the first sequence moves from
mixing/tinkering to spectacle and a flourish; the second moves from exuberant
motion through a pause into airborne abandon. This is direct evidence that the
caption model read sequence, rather than just treating the tiles as unrelated
pictures. The text remains model-generated interpretation, not a video transcript.

## Verification

38 focused tests pass, including MOV/MP4/WebM sheets; static repeated tiles;
content-hash invalidation; cached decoding; restoration of a deleted viewable
sheet without decoding; missing tools; byte/duration limits; source symlinks;
one slot per video; appearance/vibe preservation; role and sequence framing in
real Pi sessions; text-only realtime briefing; caption caching; and appearance-only
self-portrait references with contact-sheet framing. Two synthetic timelines
(1 s and 20 s) encode ten distinct color levels, then decode each output tile to
prove chronological order through the ending. That test caught and fixed an early
version dropping the last frame at the fps filter's end-of-stream boundary.

## Live three-arm comparison

[Side-by-side answers](contact-sheet-abc-report.md) use the configured
`openai-codex/gpt-6-astra` at medium effort: twelve fixed prompts, fresh contexts,
rotating arm order; all 36 calls completed. A receives written persona only; B adds canonical sprite
appearance; C instead adds the two video sheets as vibe.

The sheet arm chooses electric violet, lightning blue and molten gold, imagines
a room of knobs controlling the sky, and reacts to a lost battle with cosmic
bravado. Its self-description explicitly says the wizard clips are its energy,
not its face; its art prompt excludes the reference faces and costumes. The
sprite arm continues to describe the actual pixel character. Greetings, help
and technical explanations retain the written persona's baseline tone.

The owner's written persona hash changed since the preceding separate-frame
evaluation. Each arm in this run shares the same captured text, but differences
between runs cannot be attributed solely to contact sheets. One sample per arm
is qualitative evidence, not a measured personality effect. No voice audio,
rendered self-portrait or provider cache-hit claims are made.

## Final check and revision

Implementation: `4c63869a38fba81d7bf70f895bfe6cc65d017acf`.
`pnpm check` passed, including all 28 workspace typechecks, the complete TypeScript
test suite, 123 native Vox tests and IPC smoke. The [check receipt](contact-sheet-checks.txt)
retains totals and command outcomes. An earlier run caught two failures in a
sibling's in-progress voice tests; the owner fixed those, its 142-test file passed,
and then the full check passed. Only persona files were staged here.
