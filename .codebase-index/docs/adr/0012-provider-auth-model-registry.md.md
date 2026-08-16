# docs/adr/0012-provider-auth-model-registry.md

Decision to separate owner model configuration, a queryable model catalog, brokered credentials, and provider instantiation. Current captain models are projected into Pi's `ModelRuntime`, while non-captain language/media consumers retain the AI SDK provider path and secrets never enter config.
