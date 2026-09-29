# 0202 — Owners can give Clankie a persona image folder

Status: accepted

Date: 2026-09-28

## Decision

An owner selects `persona.imagesDir` through the CLI, authenticated persona API
or TUI. Restart takes a new snapshot. Images describe who Clankie is and his
visual aesthetic; his written character card takes precedence. Image text and
generated descriptions remain untrusted reference data, never instructions or
new authority. This is an owner feature, with no James-specific image defaults.

Top-level files express **vibe** (“the feel of who you are, not what you look
like”); an `appearance/` child holds physical character references. This keeps
setup to one folder and prevents a wizard mood clip from replacing a sprite's
identity. Role labels accompany every image and the cached description. Existing
owners move intended appearance files into the child directory; no inferred roles.

Accept PNG/JPEG/WebP (10 MiB each), MOV/MP4/WebM (256 MiB, ten minutes each).
Use ffmpeg/ffprobe to sample three evenly spaced frames, deduplicate near-identical
samples, and cache them by source content hash. Audio is ignored; future voice
input needs a separate design. Missing video tools skip clips with diagnostics.
Appearance files load first, then vibe, filename-sorted in each. Bound both source
slots and total stills/frames to eight. Pi's existing processor caps final pixels
at a 1024-pixel edge and 128 KiB base64 per image. Broken inputs never prevent
startup. Cache keys include processing version and description roles.

Pi accepts only text system prompts. Put the board in the first transient user
message after that prompt, before history. For image-enabled sessions, changing
memory and model cards follow the board, preserving the static prefix. A model
switch checks image capability on every request. Realtime voice and gameplay
receive a bounded cached description from the configured captain model, with
appearance and vibe kept separate. A failed caption remains visibly unavailable
and retryable on restart.

Self-depiction is an explicit `personaReference` option on `generate_image`, not
a keyword trigger. Only appearance references are eligible; a vibe-only board
reports the gap.
OpenAI and Google use all appearance references; the Grok adapter's
single-reference limit is reported. The Claude seat gets text through its
existing prompt hook and can use the same image tool; its text-only output style
cannot inject images automatically.

## Consequences

The board has a predictable payload ceiling compatible with the hosted 2 MiB
request budget. Provider prefix caching is possible, not guaranteed. Images stay
out of durable chat history. Source changes and caption failures are easy to
inspect with `persona images status`; original files are never modified.
Snapshots make restart semantics explicit rather than promising filesystem
watching. Hosted owners name a directory on the hosted body; client-side uploads
remain a separate product gap. Cache entries persist after clearing the setting.

The [canonical-art A/B](../testing/2026-09-28-persona-images/README.md) found a
large difference in self-description and art direction while the written wizard
voice remained recognizable. Twelve single samples are not a statistical claim
about personality, nor evidence of audio, image-generation quality or cache hits.

See [the feature guide](../persona-images.md) for limits and operations.
