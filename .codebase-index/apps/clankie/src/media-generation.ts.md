# apps/clankie/src/media-generation.ts

`ConfiguredMediaGenerator` implements operator-configured image/video generation. Provider/model roles come from settings, credentials resolve through the broker/catalog, artifacts land under `generated/` with sha256 refs, and source-image edits reread only earlier generated files.

Video jobs outlive a caller timeout: accepted renders remain tracked in memory, poll in a bounded background window, and `finishedRenders(room)` lets a later turn discover the room-scoped result. Resuming by request id collects the finished artifact/refusal; stale uncollected notices expire. Provider, credential, model, size, abort, and transport failures become typed sayable results.
