# packages/media-connector/src/index.ts

The entire media connector: schema v2 contracts
(ADR 0085) plus fetch-based provider adapters.

Schemas / constants:

- `MediaGenerationRequestSchema` — discriminated
  union of `ImageGenerationRequestSchema` (size,
  aspectRatio, optional `sourceImage` data URI →
  edit endpoint) and `VideoGenerationRequestSchema`
  (durationSeconds 1–15, resolution enum). Strict;
  schemaVersion pinned to 2.
- `MediaGenerationResultSchema` — artifactPath,
  sha256, provider/model, mimeType, bytes.
- `MEDIA_ARTIFACT_BYTES_MAX` (25 MB),
  `MEDIA_GENERATE_IMAGE_ACTION` /
  `MEDIA_GENERATE_VIDEO_ACTION` action names.

Adapters (all take `{apiKey, fetch?, endpoint?}`,
key used only in request headers):

- `OpenAiImageAdapter` — /generations JSON or
  /edits multipart (source as uploaded file).
- `GoogleImageAdapter` — generateContent with
  key in `x-goog-api-key` header, inlineData
  source part, aspectRatio via imageConfig.
- `GrokImageAdapter` — JSON for both generate and
  edit (source as typed image_url object).
- `GrokVideoAdapter` — job primitives `start` /
  `poll` / `retrieve`; retrieve pins the download
  host to `*.x.ai` HTTPS, refuses redirects, and
  bounds declared+actual length.

Shared plumbing: `writeArtifact` (mkdir, 0600
write, sha256, size ceiling),
`assertAllowedOutputPath` (refuses .aseprite and
pixel-art/sprite/atlas path components),
`readSourceImageDataUrl` helper for edit sources,
per-adapter model pinning via `requireModel`, and
`providerRequestId` from the x-request-id header.
