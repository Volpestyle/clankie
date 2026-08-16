# docs/adr/0029-media-generation-connector.md

`@clankie/media-connector`: provider-neutral
schema-v2 image and video generation contracts.
The discriminated request carries medium-specific
fields; results carry artifact path, SHA-256,
byte count, MIME type, and bounded metadata.
OpenAI, Google, and Grok adapters use plain fetch,
never read env, and write mode-0600 artifacts.

Read for the boundary rules: generation is
read-class and separate from publishing; pixel-art
namespaces are carved out (Aseprite stays
authoritative elsewhere). `media.generate.image`
and `.video` are separately governed read actions;
publication remains the reply boundary in ADR 0085.
