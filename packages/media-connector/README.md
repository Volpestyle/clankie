# Media connector

`@clankie/media-connector` is the versioned, provider-neutral boundary for local media generation.
Schema version 1 supports images; `kind` is an enum so a future schema version can add video without
leaking provider types into callers.

The package exposes fetch-based adapters for OpenAI `gpt-image-2`, Google
`gemini-3.1-flash-image`, and Grok `grok-imagine-image-quality`. Callers provide the credential and
may inject a transport. The package never reads `process.env`, imports a provider SDK, publishes an
artifact, or grants itself authority.

## Authority and security

Callers project `media.generate.image` through compiled doctrine with
`projectMediaGenerationGrant()` before invoking an adapter. The action is read-class because it
creates only a caller-selected local artifact. Uploading, posting, attaching, or otherwise
publishing that artifact is a separate `publish-external` action and retains its approval boundary.
Missing doctrine fails closed.

Provider responses are untrusted. Adapters validate their response shape, decode the image, write it
with mode `0600`, and return a validated absolute artifact path plus SHA-256 and bounded provider
metadata. Credentials are constructor inputs and are used only for the provider request.

Product pixel art remains Aseprite-MCP-only in the private `clankie-app` repository. The connector
refuses `.aseprite` outputs and paths containing pixel-art, sprite, or atlas asset directories.

```ts
const adapter = new OpenAiImageAdapter({ apiKey, fetch: auditedFetch });
const result = await adapter.generate({
  schemaVersion: 1,
  kind: "image",
  prompt: "A friendly robot tending a garden",
  size: "1536x1024",
  provider: "openai",
  model: "gpt-image-2",
  outputPath: "/private/artifacts/garden.png",
});
```
