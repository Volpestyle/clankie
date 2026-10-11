# Lead-skin contract and compiler

`@clankie/lead-skin/contract` is the version-1 lead-body schema and fail-closed
loader, with no Node imports. Clients may embed this lead in their own full
scene contract. The package's main export adds the deterministic Node compiler,
PNG codec, PNG/JPEG reference sampling, palette quantizing and artifact checks.
The installed `clankie skin` commands bundle these tools; no sibling repository,
Aseprite, ImageMagick or executable user recipe is required.

This public package owns generic data and algorithms. Character art, reference
images, reference-derived palettes, bundled product registries and client
renderers belong to their private consumers. No art ships in this package.

## Local data commands

```sh
clankie skin sample reference.png options.json --out new-sample
clankie skin compile source-directory --out new-pack
clankie skin check new-pack
```

Sampling options accept an explicit grid (`pitch`, `x`, `y`, `columns`, `rows`),
`colors` (1–64), an `approvedPalette` of RGB triples, and an explicit RGB
`background` with optional `backgroundTolerance`. Sampling preserves one pixel
per reference cell. Only background connected to the image edge is removed;
matching colors enclosed by the body survive. PNG input must be non-interlaced
8-bit RGB/RGBA. JPEG decoding uses the bounded pure-JS
[jpeg-js decoder](https://github.com/jpeg-js/jpeg-js).

Without an explicit grid, edge measurements propose a pitch and origin and
report `estimated: true` with confidence relative to other pitches. A proposal
can be wrong, including a multiple of the true pitch. Inspect the native sample
and correct it with explicit grid options before approving poses. Sampling
never resizes a tall body into a shorter cell and never implies pose approval.

A source directory contains only data:

- `skin.json`: `id`, `version`, `displayName`, `cell: {width,height}`, `scale`,
  and an ordered `animations` list.
- `palette.txt`: one single-character key plus six hex RGB digits per line;
  trailing labels and `#` comments are allowed. `.` is reserved for transparency.
- `src/ANIMATION.txt`: optional `direction` (`forward`, `reverse`, `pingpong`,
  `pingpong_reverse`) and `repeat` (0 for loop or 1 for once), followed by
  `frame MILLISECONDS` and exactly `cell.height` rows of `cell.width` keys.

Compilation requires every name in `SKIN_LEAD_ANIMATION_KEYS`. It packs cells
into one atlas row, preserving durations and playback order, and derives bounds,
feet and the glyph anchor from the first idle frame. Output is `manifest.json`,
`lead.png`, paginated `review-N.png` sheets covering every played frame, and
`artifact.json` with SHA-256 digests and sheet row/frame/timing metadata. Output
must be a new directory. The compiler follows no recipe package paths, remote
URLs or user code and does not register or publish a skin.

## Integrity and approval

`verifyLeadSkinArtifact` accepts manifest bytes, PNG bytes and hashes supplied
by an authorized catalog. It checks both digests, manifest version, required
states, timing, rectangles, dimensions and anchors before exposing the body.
`clankie skin check` instead checks consistency against the adjacent
`artifact.json`; that user-editable file is not a trusted catalog or approval.

Native cells are at most 32×96; atlases have at most 1,024 frames, 32,768 columns,
96 rows and 3,145,728 pixels. Sequences have at most 4,096 played frames in total.
Atlas and source bytes are bounded at 8 MiB, manifests at 1 MiB; reference images
at 16 MiB / 16,777,216 decoded pixels, sampled grids at 256×256. PNG dimensions
are checked before inflation, whose output is bounded by the declared scanlines.

For a new avatar, show the native base and key poses beside their references,
then obtain the owner's approval **before animating**. Animate from those approved
poses, retain the approved palette, and complete independent visual review and
refinement before publication. Mechanical checks return `ownerApproval` and
`visualReview` as `not_checked`. Provider choice, generation credits, owner catalog
storage and live selection are separate capabilities.

The service also offers [durable owner key-pose drafts](../../docs/skin-drafts.md)
for already-owned images. Its API/CLI stores exact-revision owner approval; these
offline compiler commands continue to report approval as not checked.
