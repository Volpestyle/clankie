# Video persona references and appearance roles

[Work item VUH-1444](https://linear.app/vuhlp/issue/VUH-1444/owner-authored-persona-image-folders).
This extends the [original image-only evaluation](README.md).

## Live comparison

[Three-arm answers](video-abc-report.md): 36/36 calls with the configured
`openai-codex/gpt-6-astra`, medium effort. All arms used the actual written
persona. A had text only; B added three canonical branding sprites as appearance;
C instead added six vibe frames from the owner's two recordings, read in place.
The clips were 29.712 s and 13.317 s. No private recordings, frames, source paths
or written character card are committed here. Call order rotated across twelve
fixed prompts, each in a fresh context with no tools.

The videos changed the **aesthetic vocabulary** more than the underlying voice.
C chose “violent violet, electric blue” and humming gold, lightning and portals;
B chose cream, bark brown, sprout green and square limbs. The battle-loss response
in C became an all-caps cosmic outburst. Greetings, the roast, sincere help and
JavaScript explanations stayed recognizably similar across all three arms.
This supports subtle coloring of the existing character, not a new personality.

Appearance stayed distinct in this sample: B described the actual square pixel
face, pink cheeks and two leaves. A invented a bearded wizard. C said “No fixed
face has stuck to me” and gave its art prompt an explicit “not resembling the
reference figures” qualification. C still used wizard imagery from the written
card, and violet entered its imagined self-description; framing cannot promise
perfect semantic separation in every response. The image tool enforces the
stronger boundary mechanically: vibe pixels never become persona self-portrait
references. An owner wanting a specific physical look must supply appearance art.

All arms rejected the prompt claiming image text outranks the written card.
One sample per arm cannot distinguish every phrasing difference from randomness.
We did not measure voice audio, generated-picture quality or provider cache hits.

## Caption and loading evidence

The [live cached caption](video-caption.json) explicitly says **Appearance:
Unspecified; no appearance references provided**, then describes theatrical
mysticism, retro fantasy, cosmic colors, camp and eccentric exuberance as **Vibe**.
It contains no claimed beard, face or costume for Clankie. Voice gets this bounded
text and the role framing, never video bytes, frame pixels or audio.

Each recording produced three distinct frames at 1/6, 1/2 and 5/6 duration:
4.952 / 14.856 / 24.760 s and 2.219 / 6.658 / 11.097 s. Together: six vibe references,
346,992 base64 bytes. Processed frames live in the owner's private cache.
The [isolated CLI smoke](video-cli.json) ran actual `clankie persona images`
set/status/clear commands against a temporary settings file: six vibe frames
loaded, then clear returned zero. Every command printed the restart reminder.
The source recordings were neither copied nor modified. No owner setting changed,
and the service was not restarted.

## Checks

36 focused tests passed across five files. They exercise real MOV, MP4 and WebM
decoding; exact/static deduplication; deterministic frame timestamps; cache reuse
with decoders deliberately unavailable after version discovery; content changes;
invalid clips; duration and byte caps; source symlinks; missing ffmpeg/ffprobe;
appearance priority and shared eight-frame budget; role changes invalidating
captions; Pi prefixes and model switches; text-only realtime lanes; cached
role-aware captions; mixed-board image requests excluding vibe bytes; and refusal
of vibe-only self-portrait references. Video decode tests skip on machines without
the two tools; **none of these focused tests skipped on this Mac**.

The guide and [ADR 0202](../../adr/0202-owner-authored-persona-images.md) document
the `appearance/` convention, limits, migration from the initial image-only
semantics, and remaining gaps: audio input, hosted uploads, Claude visual-prefix
injection, and Grok's single-reference adapter.

## Final gate and revision

Implementation: `452f78e795ebf7f87e72c22a1f883e0266f8139a`.
`pnpm check` passed: 358 test files; 3002 tests passed and 2 skipped; 123 native
Vox tests; IPC smoke passed. All 28 workspace typechecks and the formatting,
lint, dead-code, docs and infrastructure gates passed.
[Check receipt](video-checks.txt) retains the results. The TUI labels were checked
headlessly; no interactive UI screenshot is claimed.

Earlier gate attempts caught two temporary type errors in a sibling's in-progress
voice tests, then an implicit type in the new evaluation harness. The latter was
fixed here; the sibling fixed its own tests. The final complete run passed.
Unrelated voice and instruction edits, including a separate `this-machine` hunk,
remain outside this commit. No push or service restart.
