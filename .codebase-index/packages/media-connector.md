# packages/media-connector

Versioned, provider-neutral boundary for local
media generation (ADR 0085, schema v2): images,
image editing, and video as a discriminated union
on `kind`. Ships fetch-based adapters for OpenAI
gpt-image-2, Google gemini-3.1-flash-image, Grok
grok-imagine-image-quality, and Grok
grok-imagine-video-1.5.

Children:

- `README.md` — boundary, security, usage examples
- `package.json` — @clankie/media-connector
- `src/` — single-module schemas + adapters
- `test/` — schema and adapter suite
- `tsconfig.json` — standard noEmit config

Boundary rules:

- Never reads `process.env`, imports a provider
  SDK, publishes anywhere, or grants authority;
  credentials and transports are constructor
  inputs. The only call site is
  `ConfiguredMediaGenerator` in apps/clankie.
- Provider responses are untrusted: shapes are
  zod-validated, artifacts written mode 0600 under
  a 25 MB ceiling with SHA-256 returned; video
  downloads are host-pinned to the provider's
  domain with redirects refused (anti-SSRF).
- Refuses `.aseprite` outputs and pixel-art/
  sprite/atlas paths — product pixel art stays
  Aseprite-MCP-only elsewhere.
- Video is a job (start/poll/retrieve), never a
  blocking generate: the caller owns the wait.
