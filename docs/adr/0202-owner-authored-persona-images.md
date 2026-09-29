# 0202 — Owners can give Clankie a persona image folder

Status: accepted

Date: 2026-09-28

## Decision

An owner selects `persona.imagesDir` through the CLI, authenticated persona API
or TUI. Restart takes a new snapshot. Images describe who Clankie is and his
visual aesthetic; his written character card takes precedence. Image text and
generated descriptions remain untrusted reference data, never instructions or
new authority. This is an owner feature, with no James-specific image defaults.

Use up to eight filename-sorted PNG/JPEG/WebP files, 10 MiB source each,
downscaled through Pi's existing processor to a 1024-pixel maximum edge and
128 KiB base64 per image. Reuse that processor instead of shipping another native
image dependency. Broken files are diagnostic entries, not startup failures.
Content-addressed processed images and descriptions live in the owner's cache.

Pi accepts only text system prompts. Put the board in the first transient user
message after that prompt, before history. For image-enabled sessions, changing
memory and model cards follow the board, preserving the static prefix. A model
switch checks image capability on every request. Realtime voice and gameplay
receive only a bounded cached description from the configured captain model;
a failed caption remains visibly unavailable and retryable on restart.

Self-depiction is an explicit `personaReference` option on `generate_image`, not
a keyword trigger. OpenAI and Google use all references; the Grok adapter's
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
