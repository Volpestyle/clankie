# Media connector

`@clankie/media-connector` is the versioned, provider-neutral boundary for local media generation.
Schema version 2 ([ADR 0085](../../docs/adr/0085-a-picture-he-makes-is-something-he-says.md)) covers
images, image editing, and video; requests are a discriminated union on `kind`, so video's duration
and resolution never appear on an image request.

Image adapters cover OpenAI `gpt-image-2`, Google `gemini-3.1-flash-image`, and Grok
`grok-imagine-image-quality`; `GrokVideoAdapter` covers `grok-imagine-video-1.5`. Callers provide the
credential and may inject a transport. The package never reads `process.env`, imports a provider SDK,
publishes an artifact, or grants itself authority.

The call site is `ConfiguredMediaGenerator` in the clankie service, which owns credential
resolution and where artifacts land. Nothing else constructs these adapters.

## Authority and security

`media.generate.image` and `media.generate.video` are separate actions, and both create only a
caller-selected local artifact.

Posting a generated artifact is a separate concern with its own boundary: his own reply carrying
a picture he just made is decided by the clankie service and the presence
schema, never here. See
[ADR 0085](../../docs/adr/0085-a-picture-he-makes-is-something-he-says.md).

Provider responses are untrusted. Adapters validate their response shape, decode the image, write it
with mode `0600` under a `MEDIA_ARTIFACT_BYTES_MAX` ceiling, and return a validated absolute artifact
path plus SHA-256 and bounded provider metadata. Credentials are constructor inputs and are used only
for the provider request. A rendered video is downloaded from a provider-hosted URL: the host is
checked against the provider's own domain, redirects are refused, and both the declared and actual
lengths are bounded.

Product pixel art remains Aseprite-MCP-only in the private `clankie-app` repository. The connector
refuses `.aseprite` outputs and paths containing pixel-art, sprite, or atlas asset directories.

```ts
const adapter = new OpenAiImageAdapter({ apiKey, fetch: auditedFetch });
const result = await adapter.generate({
  schemaVersion: 2,
  kind: "image",
  prompt: "A friendly robot tending a garden",
  size: "1536x1024",
  provider: "openai",
  model: "gpt-image-2",
  outputPath: "/private/artifacts/garden.png",
});
```

Video is a job rather than a response, so the three steps stay separate primitives and the caller
owns how long it is willing to wait:

```ts
const video = new GrokVideoAdapter({ apiKey });
let job = await video.start(request); // { requestId, status: "pending" }
while (job.status === "pending") job = await video.poll(job.requestId);
const rendered = await video.retrieve(job, request);
```
