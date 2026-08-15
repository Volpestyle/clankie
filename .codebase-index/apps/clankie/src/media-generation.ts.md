# apps/clankie/src/media-generation.ts

Where making a picture or clip actually happens
(ADR 0085). `ConfiguredMediaGenerator`
implements `MediaGeneratorPort`: provider and
model come from operator config (`/image-model`,
`/video-model` in clankie.json) and never from
the request — a turn chooses what to draw, not
what to spend.

Images: resolves the role via model-provider +
bundled catalog, maps provider id → adapter
(OpenAI/Google/Grok), writes the artifact under
`<attachmentRoot>/generated/` and returns a
`sha256:<digest>:generated/<file>` ref the
Discord attach path accepts. `sourceRef` edits
re-read a previously generated file.

Videos: Grok only. `start` or resume-by
`requestId`, poll up to ~90s then return
`pending` with the id; an aborted caller stops
the wait, never the render. In-memory
`videoJobs` remembers the original request; a
restart just mints a fresh output path.

API keys: stored credential first, then the
provider's declared env vars — the same order
`/auth` reports. Every failure becomes a typed
`refused` result with a sayable reason
(no_model_configured, credential_unavailable,
provider_unsupported, provider_failed,
artifact_too_large), never a 500.
