# docs/adr/0029-media-generation-connector.md

`@clankie/media-connector`: versioned,
provider-neutral image-generation contracts.
Requests name kind/prompt/provider/model; results
carry artifact path, SHA-256, and bounded
metadata; adapters (OpenAI/Google/Grok) use plain
fetch, never read env, and write mode-0600
artifacts.

Read for the boundary rules: generation is
read-class and separate from publishing; pixel-art
namespaces are carved out (Aseprite stays
authoritative elsewhere). Schema v1 as described
here is gone — ADR 0085 incremented to v2 and
added video.
