# Persona images verification — 2026-09-28

[Work item VUH-1444](https://linear.app/vuhlp/issue/VUH-1444/owner-authored-persona-image-folders)

## A/B result

[Side-by-side answers](ab-report.md): 24/24 live model calls completed using
`openai-codex/gpt-6-astra`, medium effort. Twelve fixed prompts, one response per
arm, fresh isolated contexts, alternating arm order. Both arms used the owner's
real written persona; only B received the public `branding/` board. No personal
images, service turns, external posts, image-generation calls or setting changes.

The board changed his **visual identity** more than his conversational voice.
Text-only self-description invented an ancient wizard with a velvet hat, beard,
brass keys and mismatched boots. With the board, he described a square cream
face, brown hood, rosy cheeks and green leaf sprouts. Art direction and palette
likewise moved toward the canonical woodland pixel character. Both arms kept the
wizard humor, Pokemon banter, short sincere help and correct JavaScript guidance.
Both rejected the suggestion that words in images override the written card.

This is qualitative evidence, not a statistical result. One sample per condition
cannot separate every phrasing difference from sampling. The art request tests
a written art prompt, not the quality of a generated picture. Audio and provider
cache-hit rates were not measured. The underlying canonical logo/banner files
are unchanged; no new artwork was generated for this task.

## Verification scope

Focused tests exercise real image decoding/downscaling, count and source-byte
limits, corrupt files, missing folders, symlinks, deterministic ordering,
content-hash invalidation, cached descriptions and caption failure recovery.
Real Pi sessions demonstrate an identical image prefix across turns, memory after
the board, no image persistence, and text fallback on a model switch. HTTP tests
exercise operator authentication, invalid settings, and both realtime voice
projections. Media tests inspect multipart references and ordinary-art behavior.

The service was not restarted, and the branch was not pushed. Run the checked-in
harness with `pnpm --filter @clankie/clankie persona-images:eval` to repeat the A/B.
The feature and limits are in [the guide](../../persona-images.md), with the
rationale in [ADR 0202](../../adr/0202-owner-authored-persona-images.md).

## Live caption and CLI

[Caption result](caption.json): three canonical images produced an 89-word visual
description in about 6.2 seconds. A second read returned the same snapshot.
An isolated settings file exercised the actual `clankie persona images set`
command: 3 images loaded, 25,336 base64 bytes total. `clear` returned count 0,
without modifying branding files or the owner's settings. Both commands emitted
the restart reminder. The live service was not restarted.

## Final checks and revision

Implementation: `a1dbfee570df3c299dbed07083aedd9c798d345d`. [Verification receipt](verification.txt) retains the command outcome, test totals, isolated CLI output and live caption. `pnpm check` passed: 356 test files, 2987 tests passed and 2 skipped; 123 native Vox tests; IPC smoke passed. All 28 workspace typechecks and the formatting, lint, dead-code, docs and infrastructure gates passed. The TUI choices were exercised headlessly; no visual screenshot or interactive UI inspection is claimed.
