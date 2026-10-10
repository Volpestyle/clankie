# Media connector

`@clankie/media-connector` is the versioned, provider-neutral boundary for local media generation.
Schema version 2 ([ADR 0085](../../docs/adr/0085-a-picture-he-makes-is-something-he-says.md)) covers
images, image editing, and video; requests are a discriminated union on `kind`, so video's duration
and resolution never appear on an image request.

Image adapters cover OpenAI `gpt-image-2`, Google `gemini-3.1-flash-image`, and Grok
`grok-imagine-image-quality`. Video adapters implement `VideoGenerationAdapter`:
`GrokVideoAdapter` covers `grok-imagine-video-1.5` (prompt, or a first frame), and
`GoogleVideoAdapter` covers Veo 3.1 (`veo-3.1-generate-preview`, `-fast-`, `-lite-`)
through the Gemini API's `predictLongRunning`, with a first frame, a last frame and up
to three reference images. A provider such as Kling joins by implementing the same three
steps. Callers provide the
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
checked against the provider's own domain, a redirect is followed only to another of its hosts and
without the credential, and both the declared and actual lengths are bounded.

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

A video request may carry `firstFrame`, `lastFrame` and `referenceImages` as PNG, JPEG
or WebP data URIs; a last frame needs a first. The same image as both frames makes a
loop. Veo takes 4, 6 or 8 seconds (8 with reference images or 1080p) at 720p or
1080p, 16:9 or 9:16. Its download URL may redirect once to a Google content host;
the redirect is followed without the API key.

Persona self-depiction can supply up to eight bounded `referenceImages` data URIs.
OpenAI sends them as multipart `image[]`; Google sends inline data parts. The
current Grok adapter accepts one and explicitly rejects larger sets. The service
chooses only the owner-configured `appearance/` references via `personaReference`, never arbitrary paths
from a model. See [persona images](../../docs/persona-images.md).
