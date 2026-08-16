# ADR 0029: Versioned media-generation connector

Status: accepted (implementation baseline, 2026-07-12). The doctrine projection
used at ratification was later retired; the provider-neutral request, artifact,
credential, and publication boundaries remain.

## Context

The TUI selects image and video models while the Clankie service owns provider
calls. Calling provider SDKs from a UI or captain would spread credentials and
vendor response types. The durable boundary instead describes the requested
medium and the resulting artifact.

## Decision

`@clankie/media-connector` owns schema version 2 of
`MediaGenerationRequest` and `MediaGenerationResult`. Requests discriminate
image from video fields. Results contain an absolute artifact path, SHA-256,
byte count, MIME type, and bounded provider/model/request metadata; credentials
and provider response bodies never enter the shared result.

Adapters use plain `fetch`, accept injected transport and credentials, validate
both sides of the request, write mode-0600 artifacts, and hash the exact written
bytes. The package reads no ambient provider credentials and imports no provider
SDK.

```mermaid
flowchart LR
  T[TUI model choice] --> S[Clankie service]
  C[Credential broker] --> S
  S --> M[@clankie/media-connector v2]
  M --> P[Provider adapter]
  P --> A[Hash-bound local artifact]
  A --> R[Governed reply capture]
```

At ratification callers projected `media.generate.image` and
`media.generate.video` through compiled doctrine. That policy engine no longer
exists. The enduring separation is that generation creates a local, hash-bound
artifact; publication is a later conversational boundary defined by
[ADR 0085](0085-a-picture-he-makes-is-something-he-says.md).

Product pixel art remains carved out. Aseprite sources and their asset pipeline
are authoritative; the connector does not generate into pixel-art, sprite, or
atlas namespaces.

## Alternatives considered

- **Call provider SDKs from the TUI** was rejected because the UI would own
  credentials and vendor types.
- **Run an arbitrary shell command** was rejected because validation,
  provenance, and artifact bounds would be implicit.
- **Use one provider-neutral package with inward-dependent adapters** was
  accepted.

## Consequences

- Callers depend on one validated contract rather than provider responses.
- Credentials remain at the service call site.
- Artifact creation is independently auditable from publication.
- Current adapter and provider details belong in the
  [media connector README](../../packages/media-connector/README.md).
